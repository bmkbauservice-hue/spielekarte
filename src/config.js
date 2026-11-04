// Konfiguration aus Umgebungsvariablen (12-Factor-Prinzip: gleiches Image, andere Umgebung).

/** "/spiel/" → "/spiel", "" oder "/" → "" (kein Prefix). Ungültig → Fehler beim Start. */
export function normalizeBasePath(raw = '') {
  const trimmed = String(raw).trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(withSlash)) {
    throw new Error(`Ungültiger BASE_PATH: "${raw}" (erlaubt z. B. "/spiel")`);
  }
  return withSlash;
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '0.0.0.0',
    basePath: normalizeBasePath(env.BASE_PATH ?? ''),
  };
}
