import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class SimplexClient extends EventEmitter {
  constructor({ url, logger, commandTimeoutMs = 30000 }) {
    super();
    this.url = url;
    this.logger = logger;
    this.commandTimeoutMs = commandTimeoutMs;
    this.ws = null;
    this.pending = new Map();
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connectPromise = null;
    this.activeUserId = null;
    this.profileUpdates = new Map();
  }

  start() {
    this.stopped = false;
    return this.#connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SimpleX client stopped'));
    }
    this.pending.clear();
  }

  async waitUntilOpen(timeoutMs = 30000) {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`SimpleX WebSocket not connected after ${timeoutMs}ms`);
  }

  async sendCommand(cmd) {
    await this.waitUntilOpen();
    const corrId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(corrId);
        reject(new Error(`SimpleX command timed out: ${cmd.split(' ')[0]}`));
      }, this.commandTimeoutMs);

      this.pending.set(corrId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ corrId, cmd }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(corrId);
        reject(error);
      });
    });
  }

  sendText(chatRef, text) {
    return this.sendMessages(chatRef, [{ msgContent: { type: 'text', text: String(text) } }]);
  }

  sendFile(chatRef, filePath, text = '') {
    return this.sendMessages(chatRef, [{
      fileSource: { filePath: String(filePath) },
      msgContent: { type: 'file', text: String(text || '') }
    }]);
  }

  sendMessages(chatRef, messages) {
    return this.sendCommand(`/_send ${chatRef} json ${JSON.stringify(messages)}`);
  }

  receiveFile(fileId, filePath) {
    return this.sendCommand(`/freceive ${Number(fileId)} ${String(filePath)}`);
  }

  async getActiveUserId() {
    if (this.activeUserId) return this.activeUserId;
    const response = await this.sendCommand('/user');
    const userId = response?.user?.userId;
    if (!Number.isInteger(userId)) throw new Error('SimpleX active user ID not found');
    this.activeUserId = userId;
    return userId;
  }

  async createGroup({ displayName, fullName = displayName, description }) {
    const userId = await this.getActiveUserId();
    const profile = {
      displayName: String(displayName),
      fullName: String(fullName),
      shortDescr: 'WhatsApp via WA2SimpleX',
      description: description || 'Private WhatsApp bridge chat created by WA2SimpleX.'
    };
    const response = await this.sendCommand(`/_group ${userId} ${JSON.stringify(profile)}`);
    if (!Number.isInteger(response?.groupInfo?.groupId)) throw new Error('SimpleX group creation returned no group ID');
    return response.groupInfo;
  }

  addMember(groupId, contactId, role = 'admin') {
    return this.sendCommand(`/_add #${Number(groupId)} ${Number(contactId)} ${role}`);
  }

  listGroupMembers(groupId) {
    return this.sendCommand(`/_members #${Number(groupId)}`);
  }

  setGroupCustomData(groupId, customData) {
    return this.sendCommand(`/_set custom #${Number(groupId)} ${JSON.stringify(customData)}`);
  }

  async listGroups() {
    const userId = await this.getActiveUserId();
    const response = await this.sendCommand(`/_groups ${userId}`);
    return response?.groups ?? [];
  }

  async updateGroupName(groupId, displayName) {
    return this.updateGroupProfile(groupId, { displayName: String(displayName), fullName: String(displayName) });
  }

  updateGroupImage(groupId, image) {
    return this.updateGroupProfile(groupId, { image });
  }

  updateGroupProfile(groupId, changes) {
    const previous = this.profileUpdates.get(groupId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const groups = await this.listGroups();
      const group = groups.find(item => Number(item?.groupId) === Number(groupId));
      if (!group?.groupProfile) throw new Error(`SimpleX group #${groupId} not found`);
      const profile = { ...group.groupProfile, ...changes };
      return this.sendCommand(`/_group_profile #${Number(groupId)} ${JSON.stringify(profile)}`);
    }).finally(() => { if (this.profileUpdates.get(groupId) === pending) this.profileUpdates.delete(groupId); });
    this.profileUpdates.set(groupId, pending);
    return pending;
  }

  #connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve) => {
      this.logger.info('Connecting to SimpleX CLI', { url: this.url });
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectAttempt = 0;
        this.activeUserId = null;
        this.logger.info('SimpleX WebSocket connected');
        this.emit('connected');
        resolve();
      });

      ws.on('message', (data) => this.#onMessage(data));
      ws.on('error', (error) => this.logger.warn('SimpleX WebSocket error', { error: error.message }));
      ws.on('close', () => {
        this.logger.warn('SimpleX WebSocket disconnected');
        this.ws = null;
        this.connectPromise = null;
        this.activeUserId = null;
        this.emit('disconnected');
        if (!this.stopped) this.#scheduleReconnect();
      });
    });
    return this.connectPromise;
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.logger.warn('Ignoring invalid JSON from SimpleX CLI');
      return;
    }

    if (message.corrId && this.pending.has(message.corrId)) {
      const pending = this.pending.get(message.corrId);
      this.pending.delete(message.corrId);
      clearTimeout(pending.timer);
      if (message.resp?.type === 'chatCmdError') {
        pending.reject(new Error(`SimpleX command failed: ${JSON.stringify(message.resp.chatError ?? message.resp)}`));
      } else {
        pending.resolve(message.resp);
      }
      return;
    }

    if (message.resp) this.emit('event', message.resp);
  }

  #scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    setTimeout(() => {
      if (!this.stopped) this.#connect().catch(() => {});
    }, delay);
  }
}
