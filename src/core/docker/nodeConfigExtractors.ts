import fs from 'fs';
import path from 'path';
import { ChainEnvData } from '../../types/index.js';
import { NODE_CONFIG_FILENAME } from '../../types/constants.js';
import { getNodeConfigPath, createNodeConfigPaths } from '../../utils/nodeConfigUtils.js';
import { NodeConfigVerifier } from '../deployChain/prepareNodeConfig.js';
import logger from '../../utils/logger.js';

export const extractParentUrlsFromNodeConfigFile = (): { parentUrl?: string; beaconUrl?: string } => {
  try {
    const file = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(file)) return { parentUrl: process.env.PARENT_CHAIN_RPC };
    const raw = fs.readFileSync(file, 'utf8');
    const json: any = JSON.parse(raw);

    const parentUrl: string | undefined =
      json?.['parent-chain']?.connection?.url ??
      json?.node?.['data-availability']?.['parent-chain-node-url'] ??
      json?.parentChainRpcUrl ??
      json?.parentChainConnectionUrl ??
      json?.parentChain?.rpcUrl ??
      json?.parentChain?.connection?.url ??
      process.env.PARENT_CHAIN_RPC;

    return { parentUrl };
  } catch (_) {
    return { parentUrl: process.env.PARENT_CHAIN_RPC };
  }
};

export const extractChainIdFromNodeConfigFile = (): number | undefined => {
  try {
    const file = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const json: any = JSON.parse(raw);

    const parseNum = (val: unknown): number | undefined => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string' && val.trim() !== '') {
        const n = Number(val);
        return Number.isNaN(n) ? undefined : n;
      }
      return undefined;
    };

    const findChainId = (obj: any): number | undefined => {
      if (!obj || typeof obj !== 'object') return undefined;
      const direct = parseNum(obj.chainId) ?? parseNum(obj['chain-id']);
      if (direct !== undefined) return direct;
      const cfg = obj['chain-config'] ?? obj.chainConfig;
      const fromCfg = parseNum(cfg?.chainId) ?? parseNum(cfg?.['chain-id']);
      if (fromCfg !== undefined) return fromCfg;
      for (const v of Object.values(obj)) {
        const r = findChainId(v);
        if (r !== undefined) return r;
      }
      return undefined;
    };

    const infoRaw = json?.chain?.['info-json'];
    if (typeof infoRaw === 'string' && infoRaw.trim() !== '') {
      try {
        const parsed = JSON.parse(infoRaw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const cid = findChainId(item);
            if (cid !== undefined) return cid;
          }
        } else if (parsed && typeof parsed === 'object') {
          const cid = findChainId(parsed);
          if (cid !== undefined) return cid;
        }
      } catch (_) {}
    }

    return findChainId(json);
  } catch (_) {
    return undefined;
  }
};

export const extractChainParamsFromNodeConfigFile = (): {
  chainId?: number;
  parentUrl?: string;
  beaconUrl?: string;
} => {
  try {
    const file = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(file)) return {};
    const chainId = extractChainIdFromNodeConfigFile();
    const { parentUrl, beaconUrl } = extractParentUrlsFromNodeConfigFile();

    return { chainId, parentUrl, beaconUrl };
  } catch (_) {
    return {};
  }
};

export const extractHttpPortFromNodeConfigFile = (): number | undefined => {
  try {
    const file = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const json: any = JSON.parse(raw);
    const p = json?.http?.port;
    if (typeof p === 'number') return p;
    if (typeof p === 'string' && p.trim() !== '') {
      const n = Number(p);
      return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
  } catch (_) {
    return undefined;
  }
};

export const extractWsPortFromNodeConfigFile = (): number | undefined => {
  try {
    const file = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const json: any = JSON.parse(raw);
    const p = json?.ws?.port;
    if (typeof p === 'number') return p;
    if (typeof p === 'string' && p.trim() !== '') {
      const n = Number(p);
      return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
  } catch (_) {
    return undefined;
  }
};

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

export const tryLoadChainEnvFromNodeConfig = (): ChainEnvData | null => {
  try {
    const nodeConfigPath = getNodeConfigPath();
    if (!fs.existsSync(nodeConfigPath)) return null;
    const raw = fs.readFileSync(nodeConfigPath, 'utf8');
    const nodeConfig: any = JSON.parse(raw);

    // Extract chainConfig from chain.info-json
    const infoRaw = nodeConfig?.chain?.['info-json'];
    if (typeof infoRaw === 'string' && infoRaw.trim() !== '') {
      try {
        const parsed = JSON.parse(infoRaw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const chainConfig = item?.['chain-config'] ?? item?.chainConfig;
          if (chainConfig && typeof chainConfig === 'object') {
            // Initialize nodeConfigPaths with MAIN type by default
            const nodeConfigPaths = createNodeConfigPaths();
            return {
              nodeConfig,
              nodeConfigPaths,
              chainConfig: chainConfig as ChainEnvData['chainConfig'],
            };
          }
        }
      } catch (_) {
        // ignore
      }
    }

    return null;
  } catch {
    return null;
  }
};

export const verifyNodeConfigFile = (configPath?: string): { isValid: boolean; errors: string[] } => {
  try {
    logger.info('start verifying config.......');
    const filePath = configPath || path.join(process.cwd(), NODE_CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) {
      return { isValid: false, errors: ['Config file not found'] };
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const config = JSON.parse(raw);

    const verifier = new NodeConfigVerifier();
    return verifier.verifyConfig(config);
  } catch (error) {
    return { isValid: false, errors: [`Failed to verify config: ${(error as Error).message}`] };
  }
};
