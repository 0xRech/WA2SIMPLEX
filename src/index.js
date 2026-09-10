import express from 'express';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { SimplexClient } from './simplex.js';
import { WhatsAppClient, extractWhatsAppMessages, verifyMetaSignature } from './whatsapp.js';
import { BridgeRouter } from './router.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = express();

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

const simplex = new SimplexClient({ url: config.simplex.wsUrl, logger });
const whatsapp = new WhatsAppClient({ ...config.whatsapp, logger });
const router = new BridgeRouter({
  simplex,
  whatsapp,
  simplexTarget: config.simplex.target,
  restrictToTarget: config.simplex.restrictToTarget,
  markWhatsAppRead: config.whatsapp.markRead,
  logger
});

simplex.on('event', (event) => {
  router.handleSimplexEvent(event).catch((error) => logger.error('SimpleX event handling failed', { error: error.message }));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'WA2SimpleX',
    simplexConnected: simplex.ws?.readyState === 1,
    now: new Date().toISOString()
  });
});

app.get('/webhook', (req, res) => {
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
  const signature = req.get('x-hub-signature-256');
  if (!verifyMetaSignature(req.rawBody, signature, config.whatsapp.appSecret)) {
    logger.warn('Rejected WhatsApp webhook with invalid signature');
    return res.sendStatus(401);
  }

  res.sendStatus(200);

  const messages = extractWhatsAppMessages(req.body);
  Promise.allSettled(messages.map((message) => router.handleWhatsApp(message))).then((results) => {
    for (const result of results) {
      if (result.status === 'rejected') logger.error('WhatsApp webhook processing failed', { error: result.reason?.message || String(result.reason) });
    }
  });
});

app.use((error, _req, res, _next) => {
  logger.error('HTTP error', { error: error.message });
  if (!res.headersSent) res.status(400).json({ ok: false });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info('WA2SimpleX HTTP server listening', { port: config.port });
});

simplex.start().catch((error) => logger.error('Initial SimpleX connection failed', { error: error.message }));

function shutdown(signal) {
  logger.info('Shutting down', { signal });
  simplex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
