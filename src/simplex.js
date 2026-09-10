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
    const messages = [{ msgContent: { type: 'text', text } }];
    return this.sendCommand(`/_send ${chatRef} json ${JSON.stringify(messages)}`);
  }

  #connect() {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve) => {
      this.logger.info('Connecting to SimpleX CLI', { url: this.url });
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectAttempt = 0;
        this.logger.info('SimpleX WebSocket connected');
        this.emit('connected');
        resolve();
      });

      ws.on('message', (data) => this.#onMessage(data));

      ws.on('error', (error) => {
        this.logger.warn('SimpleX WebSocket error', { error: error.message });
      });

      ws.on('close', () => {
        this.logger.warn('SimpleX WebSocket disconnected');
        this.ws = null;
        this.connectPromise = null;
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
