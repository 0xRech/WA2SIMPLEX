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

export function parseGroupBridges(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];

  if (value.startsWith('[')) {
    let parsed;
    try { parsed = JSON.parse(value); }
    catch (error) { throw new Error(`WA2SIMPLEX_GROUP_BRIDGES contains invalid JSON: ${error.message}`); }
    if (!Array.isArray(parsed)) throw new Error('WA2SIMPLEX_GROUP_BRIDGES JSON must be an array');
    return parsed;
  }

  return value.split(';').map((entry, index) => {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const separator = trimmed.indexOf('=');
    if (separator < 1) throw new Error(`Invalid group bridge #${index + 1}; expected SIMPLEX_GROUP_ID=WHATSAPP_GROUP_JID`);
    const left = trimmed.slice(0, separator).trim();
    const whatsappJid = trimmed.slice(separator + 1).trim();
    const nameSeparator = left.indexOf('|');
    const name = nameSeparator >= 0 ? left.slice(0, nameSeparator).trim() : '';
    const simplexRaw = nameSeparator >= 0 ? left.slice(nameSeparator + 1).trim() : left;
    const simplexGroupId = Number(simplexRaw.replace(/^#/, ''));
    if (!Number.isInteger(simplexGroupId) || simplexGroupId <= 0) throw new Error(`Invalid SimpleX group ID in group bridge #${index + 1}`);
    return { name: name || `#${simplexGroupId}`, simplexGroupId, whatsappJid };
  }).filter(Boolean);
}

export function loadConfig() {
  const provider = (process.env.WHATSAPP_PROVIDER || 'cloud').trim().toLowerCase();
  if (!['cloud', 'web'].includes(provider)) throw new Error('WHATSAPP_PROVIDER must be cloud or web');
  const controlTarget = (process.env.SIMPLEX_CONTROL_TARGET || process.env.SIMPLEX_TARGET || '').trim();
  if ((controlTarget || provider === 'cloud') && !/^@[1-9]\d*$/.test(controlTarget)) {
    throw new Error('SIMPLEX_CONTROL_TARGET must be a direct SimpleX contact such as @2. SIMPLEX_TARGET is accepted as a legacy alias.');
  }

  const mediaMaxMb = number(process.env.MEDIA_MAX_MB, 32);
  const retentionMinutes = number(process.env.MEDIA_RETENTION_MINUTES, 60);
  const groupBridges = parseGroupBridges(process.env.WA2SIMPLEX_GROUP_BRIDGES || process.env.GROUP_BRIDGES || '');
  if (groupBridges.length && provider !== 'web') {
    throw new Error('WA2SIMPLEX group bridges currently require WHATSAPP_PROVIDER=web');
  }

  return {
    port: Number(process.env.PORT || 3000),
    logLevel: process.env.LOG_LEVEL || 'info',
    dbPath: process.env.DB_PATH || './data/wa2simplex.db',
    groupBridges,
    media: {
      enabled: bool(process.env.MEDIA_ENABLED, true),
      dir: process.env.MEDIA_DIR || './data/media',
      maxBytes: Math.floor(mediaMaxMb * 1024 * 1024),
      retentionMs: Math.floor(retentionMinutes * 60 * 1000)
    },
    whatsapp: {
      provider,
      authPath: process.env.WHATSAPP_AUTH_PATH || './data/whatsapp/auth.db',
      qrPath: process.env.WHATSAPP_QR_PATH || './data/whatsapp/pairing.txt',
      verifyToken: provider === 'cloud' ? required('WHATSAPP_VERIFY_TOKEN') : '',
      accessToken: provider === 'cloud' ? required('WHATSAPP_ACCESS_TOKEN') : '',
      phoneNumberId: provider === 'cloud' ? required('WHATSAPP_PHONE_NUMBER_ID') : '',
      appSecret: provider === 'cloud' ? required('WHATSAPP_APP_SECRET') : '',
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
