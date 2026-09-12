import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SimplexClient } from './simplex.js';
import { WhatsAppClient, extractWhatsAppMessages, verifyMetaSignature } from './whatsapp.js';
import { BridgeRouter } from './router.js';
import { BridgeStore } from './storage.js';

process.umask(0o077);
const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = express();
const store = new BridgeStore(config.dbPath);

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const simplex = new SimplexClient({ url: config.simplex.wsUrl, logger });
const webMode = config.whatsapp.provider === 'web';
let router;
const whatsapp = webMode
  ? new (await import('./whatsapp-web.js')).WhatsAppWebClient({
    ...config.whatsapp, logger, maxBytes: config.media.maxBytes,
    onMessage: async message => {
      if (!router) return;
      await router.handleWhatsApp(message);
    }
  })
  : new WhatsAppClient({ ...config.whatsapp, logger });
router = config.simplex.controlTarget ? new BridgeRouter({
  simplex,
  whatsapp,
  store,
  controlTarget: config.simplex.controlTarget,
  ownerContactId: config.simplex.ownerContactId,
  groupPrefix: config.simplex.groupPrefix,
  markWhatsAppRead: config.whatsapp.markRead,
  mediaEnabled: config.media.enabled,
  mediaDir: config.media.dir,
  maxMediaBytes: config.media.maxBytes,
  mediaRetentionMs: config.media.retentionMs,
  logger
}) : null;

simplex.on('event', (event) => {
  if (!router) return;
  router.handleSimplexEvent(event).catch((error) => {
    logger.error('SimpleX event handling failed', { error: error.message });
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'WA2SimpleX',
    version: '0.3.0-alpha.1',
    simplexConnected: simplex.ws?.readyState === 1,
    whatsappProvider: config.whatsapp.provider,
    whatsappGroupsEnabled: config.whatsapp.groupsEnabled,
    whatsappStatus: webMode ? whatsapp.status : 'cloud_configured',
    routingConfigured: Boolean(router),
    mediaBridge: config.media.enabled,
    mediaMaxBytes: config.media.maxBytes,
    contacts: store.stats(),
    now: new Date().toISOString()
  });
});

app.get('/webhook', (req, res) => {
  if (webMode) return res.sendStatus(404);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  if (webMode) return res.sendStatus(404);
  const signature = req.get('x-hub-signature-256');
  if (!verifyMetaSignature(req.rawBody, signature, config.whatsapp.appSecret)) {
    logger.warn('Rejected WhatsApp webhook with invalid signature');
    return res.sendStatus(401);
  }

  res.sendStatus(200);
  const messages = extractWhatsAppMessages(req.body);
  Promise.allSettled(messages.map((message) => router.handleWhatsApp(message))).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('WhatsApp webhook processing failed', { error: result.reason?.message || String(result.reason) });
      }
    }
  });
});

app.use((error, _req, res, _next) => {
  logger.error('HTTP error', { error: error.message });
  if (!res.headersSent) res.status(400).json({ ok: false });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('WA2SimpleX HTTP server listening', { port: config.port, mediaBridge: config.media.enabled });
});

simplex.start()
  .then(() => router?.initialize())
  .catch((error) => logger.error('Initial SimpleX connection failed', { error: error.message }));

if (webMode) {
  if (!router) logger.warn('Pairing only: configure SIMPLEX_CONTROL_TARGET before forwarding messages');
  whatsapp.start().catch(error => {
    logger.error('WhatsApp startup failed', { error: error.message });
    shutdown('startup_failure');
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  const deadline = setTimeout(() => process.exit(1), 5000);
  deadline.unref();
  if (webMode) await whatsapp.stop().catch(() => {});
  simplex.stop();
  store.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
