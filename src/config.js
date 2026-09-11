import 'dotenv/config';

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  const controlTarget = (process.env.SIMPLEX_CONTROL_TARGET || process.env.SIMPLEX_TARGET || '').trim();
  if (!/^@\d+$/.test(controlTarget)) {
    throw new Error('SIMPLEX_CONTROL_TARGET must be a direct SimpleX contact such as @2. SIMPLEX_TARGET is accepted as a legacy alias.');
  }

  const mediaMaxMb = number(process.env.MEDIA_MAX_MB, 32);
  const retentionMinutes = number(process.env.MEDIA_RETENTION_MINUTES, 60);

  return {
    port: Number(process.env.PORT || 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    dbPath: process.env.DB_PATH || './data/wa2simplex.db',
    media: {
      enabled: bool(process.env.MEDIA_ENABLED, true),
      dir: process.env.MEDIA_DIR || './data/media',
      maxBytes: Math.floor(mediaMaxMb * 1024 * 1024),
      retentionMs: Math.floor(retentionMinutes * 60 * 1000)
    },
    whatsapp: {
      verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
      accessToken: required('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
      appSecret: required('WHATSAPP_APP_SECRET'),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v26.0',
      markRead: bool(process.env.WHATSAPP_MARK_READ, true)
    },
    simplex: {
      wsUrl: process.env.SIMPLEX_WS_URL || 'ws://127.0.0.1:5225',
      controlTarget,
      ownerContactId: Number(controlTarget.slice(1)),
      groupPrefix: (process.env.SIMPLEX_GROUP_PREFIX || 'WA').trim().slice(0, 16) || 'WA'
    }
  };
}
