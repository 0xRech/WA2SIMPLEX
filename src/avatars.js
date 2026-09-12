import sharp from 'sharp';
import { createHash } from 'node:crypto';

export async function encodeAvatar(buffer) {
  if (!buffer?.length || buffer.length > 2 * 1024 * 1024) throw new Error('Invalid avatar size');
  const image = await sharp(buffer, { limitInputPixels: 16 * 1024 * 1024, animated: false })
    .rotate().resize(96, 96, { fit: 'cover' }).flatten({ background: '#ffffff' })
    .jpeg({ quality: 60, mozjpeg: true }).toBuffer();
  const data = `data:image/jpg;base64,${image.toString('base64')}`;
  if (data.length > 12000) throw new Error('Encoded avatar exceeds SimpleX limit');
  return { data, hash: createHash('sha256').update(image).digest('hex') };
}

export class AvatarSync {
  constructor({ store, whatsapp, simplex, logger, intervalMs = 6 * 60 * 60 * 1000 }) {
    Object.assign(this, { store, whatsapp, simplex, logger, intervalMs });
    this.stopped = false;
    this.running = null;
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    this.timer.unref();
    this.tick().catch(() => {});
  }
  tick() {
    if (this.running || this.stopped || this.whatsapp.status !== 'connected' || this.simplex.ws?.readyState !== 1) return this.running || Promise.resolve();
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    for (const contact of this.store.listAvatarsDue(Date.now(), this.intervalMs, 10)) {
      if (this.stopped || this.whatsapp.status !== 'connected') break;
      const previous = this.store.getAvatarState(contact.phone);
      try {
        const buffer = await this.whatsapp.getProfilePicture(contact.phone);
        if (this.stopped) break;
        const avatar = buffer ? await encodeAvatar(buffer) : { data: null, hash: '' };
        // Repairs can replace the target SimpleX group while a download is in progress.
        const current = this.store.getContact(contact.phone);
        if (current?.simplexGroupId !== contact.simplexGroupId) continue;
        if (avatar.hash !== (previous?.hash || '') || (avatar.hash && previous?.groupId !== contact.simplexGroupId)) {
          await this.simplex.updateGroupImage(contact.simplexGroupId, avatar.data);
          this.logger.info('WhatsApp chat image synchronized', { groupId: contact.simplexGroupId, hasImage: Boolean(avatar.data) });
        }
        this.store.setAvatarState(contact.phone, contact.simplexGroupId, avatar.hash, Date.now());
      } catch {
        // No URLs, picture contents or authentication details belong in logs.
        this.logger.warn('Chat image refresh deferred', { groupId: contact.simplexGroupId });
        this.store.deferAvatar(contact.phone, previous?.groupId ?? contact.simplexGroupId, previous?.hash ?? '', Date.now() + 15 * 60 * 1000);
      }
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running;
  }
}
