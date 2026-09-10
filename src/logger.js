const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = levels[level] ?? levels.info;

  function write(kind, message, extra) {
    if ((levels[kind] ?? 999) < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: kind,
      message,
      ...(extra && typeof extra === 'object' ? extra : {})
    };
    const out = kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log;
    out(JSON.stringify(payload));
  }

  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e)
  };
}
