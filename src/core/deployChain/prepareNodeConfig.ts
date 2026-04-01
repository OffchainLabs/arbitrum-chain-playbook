import { NodeConfig } from '@arbitrum/chain-sdk';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { NODE_CONFIG_FILENAME } from '../../types/constants.js';
import {
  overwriteToNodeConfigForFastValidator,
  overwriteToNodeConfigForFastBatchPoster,
  overwriteToNodeConfigForIncorrectWasmValidator,
  overwriteToNodeConfigForMaliciousValidator,
  overwriteToNodeConfigForMaliciousMint,
  overwriteToNodeConfigForDeletingBoldStrategy,
} from '../../utils/nodeConfigUtils.js';

// Overwrite options type
export type OverwriteOption =
  | 'fast-validator'
  | 'fast-batch-poster'
  | 'incorrect-wasm-validator'
  | 'malicious-validator'
  | 'malicious-mint'
  | 'deleting-bold-strategy';

// Overwrite option labels
export const OVERWRITE_OPTIONS: Record<OverwriteOption, string> = {
  'fast-validator': 'Fast Validator',
  'fast-batch-poster': 'Fast Batch Poster',
  'incorrect-wasm-validator': 'Incorrect Wasm Validator',
  'malicious-validator': 'Malicious Validator',
  'malicious-mint': 'Malicious Mint (BlockValidator + local WASM)',
  'deleting-bold-strategy': 'Deleting Bold Strategy (For old SDK generated node config)',
};

export interface VerificationResult {
  isValid: boolean;
  errors: string[];
}

export class NodeConfigVerifier {
  private defaultRequiredFields = [
    'chain.info-json',
    'chain.name',
    'parent-chain.connection.url',
    'http.port',
    'http.addr',
  ];

  verifyConfig(config: any, requiredFields: string[] = this.defaultRequiredFields): VerificationResult {
    const errors: string[] = [];

    for (const field of requiredFields) {
      if (!this.hasNestedProperty(config, field)) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Validate chain ID consistency
    const chainIdFromConfig = this.extractChainId(config);
    const chainIdFromInfoJson = this.extractChainIdFromInfoJson(config);

    if (chainIdFromConfig && chainIdFromInfoJson && chainIdFromConfig !== chainIdFromInfoJson) {
      errors.push(`Chain ID mismatch: config=${chainIdFromConfig}, info-json=${chainIdFromInfoJson}`);
    }

    // Validate port number
    const port = config?.http?.port;
    if (port && (typeof port !== 'number' || port < 1 || port > 65535)) {
      errors.push('Invalid port number: must be between 1-65535');
    }

    // Validate parent chain URL
    const parentUrl = config?.['parent-chain']?.connection?.url;
    if (parentUrl && !this.isValidUrl(parentUrl)) {
      errors.push('Invalid parent chain URL format');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  private hasNestedProperty(obj: any, path: string): boolean {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
      if (current === null || current === undefined || !(key in current)) {
        return false;
      }
      current = current[key];
    }

    return current !== undefined && current !== null;
  }

  private extractChainId(config: any): number | null {
    return this.findChainIdInObject(config);
  }

  private extractChainIdFromInfoJson(config: any): number | null {
    try {
      const infoJson = config?.chain?.['info-json'];
      if (typeof infoJson === 'string') {
        const parsed = JSON.parse(infoJson);
        const items = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of items) {
          const chainId = this.findChainIdInObject(item);
          if (chainId !== null) return chainId;
        }
      }
    } catch {
      // Ignore parsing errors
    }
    return null;
  }

  private findChainIdInObject(obj: any): number | null {
    if (!obj || typeof obj !== 'object') return null;

    // Direct chainId or chain-id
    const directId = this.parseChainIdNumber(obj.chainId) ?? this.parseChainIdNumber(obj['chain-id']);
    if (directId !== null) return directId;

    // Chain config nested
    const chainConfig = obj['chain-config'] ?? obj.chainConfig;
    if (chainConfig) {
      const nestedId = this.parseChainIdNumber(chainConfig.chainId) ?? this.parseChainIdNumber(chainConfig['chain-id']);
      if (nestedId !== null) return nestedId;
    }

    // Recursive search
    for (const value of Object.values(obj)) {
      const result = this.findChainIdInObject(value);
      if (result !== null) return result;
    }

    return null;
  }

  private parseChainIdNumber(val: unknown): number | null {
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const n = Number(val);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Apply overwrite function to node config based on option
 */
export function applyOverwriteToNodeConfig(nodeConfig: NodeConfig, option: OverwriteOption): NodeConfig {
  switch (option) {
    case 'fast-validator':
      return overwriteToNodeConfigForFastValidator(nodeConfig);
    case 'fast-batch-poster':
      return overwriteToNodeConfigForFastBatchPoster(nodeConfig);
    case 'incorrect-wasm-validator':
      return overwriteToNodeConfigForIncorrectWasmValidator(nodeConfig);
    case 'malicious-validator':
      return overwriteToNodeConfigForMaliciousValidator(nodeConfig);
    case 'malicious-mint':
      return overwriteToNodeConfigForMaliciousMint(nodeConfig);
    case 'deleting-bold-strategy':
      return overwriteToNodeConfigForDeletingBoldStrategy(nodeConfig);
    default:
      return nodeConfig;
  }
}

/**
 * Read node-config.json, apply overwrite function, and write back
 */
export async function overwriteNodeConfigFile(
  option: OverwriteOption,
  configPath: string = NODE_CONFIG_FILENAME,
): Promise<void> {
  // Check if file exists
  if (!existsSync(configPath)) {
    throw new Error(`Node config file not found: ${configPath}`);
  }

  // Read the existing config
  const fileContent = await readFile(configPath, 'utf-8');
  const nodeConfig: NodeConfig = JSON.parse(fileContent);

  // Apply the overwrite function
  const overwrittenConfig = applyOverwriteToNodeConfig(nodeConfig, option);

  // Write back to file
  await writeFile(configPath, JSON.stringify(overwrittenConfig, null, 2));
}
