import 'dotenv/config';

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
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

  return {
    port: Number(process.env.PORT || 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    dbPath: process.env.DB_PATH || './data/wa2simplex.db',
    whatsapp: {
      verifyToken: required('WHATSAPP_VERIFY_TOKEN'),
      accessToken: required('WHATSAPP_ACCESS_TOKEN'),
      phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
      appSecret: required('WHATSAPP_APP_SECRET'),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
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
