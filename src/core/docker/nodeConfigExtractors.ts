import fs from 'fs';

const parsePortValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
};

/**
 * Extract HTTP port from a specific config file path.
 * HTTP port is required and throws if missing or invalid.
 */
export const extractHttpPortFromConfigPath = (configPath: string): number => {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const json: any = JSON.parse(raw);

  if (!json?.http || typeof json.http !== 'object') {
    throw new Error(`Missing 'http' section in config: ${configPath}`);
  }

  const port = parsePortValue(json.http.port);
  if (port !== undefined) return port;

  throw new Error(`Missing or invalid 'http.port' in config: ${configPath}`);
};

/**
 * Extract WS port from a specific config file path.
 * WS port is optional and defaults to 0 when missing or invalid.
 */
export const extractWsPortFromConfigPath = (configPath: string): number => {
  try {
    if (!fs.existsSync(configPath)) return 0;
    const raw = fs.readFileSync(configPath, 'utf8');
    const json: any = JSON.parse(raw);
    const port = parsePortValue(json?.ws?.port);
    if (port !== undefined) return port;

    if (!json || typeof json !== 'object') return 0;
    if (!json.ws || typeof json.ws !== 'object') {
      json.ws = {};
    }
    json.ws.port = 0;
    fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
    return 0;
  } catch (_) {
    return 0;
  }
};
