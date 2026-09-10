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
  const simplexTarget = required('SIMPLEX_TARGET');
  if (!/^[@#]\d+$/.test(simplexTarget)) {
    throw new Error('SIMPLEX_TARGET must look like @2 (direct chat) or #5 (group).');
  }

  return {
    port: Number(process.env.PORT || 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
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
      target: simplexTarget,
      restrictToTarget: bool(process.env.SIMPLEX_RESTRICT_TO_TARGET, true)
    }
  };
}
