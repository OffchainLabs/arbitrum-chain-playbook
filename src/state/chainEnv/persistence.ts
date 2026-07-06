/**
 * ChainEnv Persistence Module
 *
 * Handles saving and loading chain configuration to/from disk
 */

import fs from 'fs';
import path from 'path';
import { ChainConfig, NodeConfig } from '@arbitrum/chain-sdk';
import { ChainData, NodeType } from '../../types/index.js';
import { CoreContracts } from './types.js';
import { LOCAL_DATA_DIR } from '../../types/constants.js';
import {
  discoverNodeConfigs,
  getNodeConfigPath,
  getNodeConfigPathForType,
  createNodeConfigPaths,
} from '../../utils/nodeConfigUtils.js';

/**
 * Check if node config file exists
 * Uses the new discovery logic to find any valid configuration files
 */
export function nodeConfigFileExists(): boolean {
  // First check the default location
  if (fs.existsSync(getNodeConfigPath())) {
    return true;
  }

  // Use discovery logic to find any available config files
  const discoveredConfigs = discoverNodeConfigs();
  return discoveredConfigs.size > 0;
}

/**
 * Extract chain config from node config's chain.info-json field
 */
function extractChainConfigFromNodeConfig(nodeConfig: any): ChainConfig | null {
  try {
    const infoRaw = nodeConfig?.chain?.['info-json'];
    if (typeof infoRaw === 'string' && infoRaw.trim() !== '') {
      const parsed = JSON.parse(infoRaw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const chainConfig = item?.['chain-config'] ?? item?.chainConfig;
        if (chainConfig && typeof chainConfig === 'object') {
          return chainConfig as ChainConfig;
        }
      }
    }
  } catch (_) {
    // ignore parsing errors
  }
  return null;
}

/**
 * Path of the persisted core-contracts file for a chain:
 * <cwd>/<LOCAL_DATA_DIR>/<chainId>/core-contracts.json
 */
function coreContractsFilePath(chainId: number | bigint): string {
  return path.join(process.cwd(), LOCAL_DATA_DIR, chainId.toString(), 'core-contracts.json');
}

/**
 * Persist the full core-contracts set for a chain so a restart without
 * CHAIN_DEPLOYMENT_TRANSACTION_HASH doesn't lose the inbox/rollup addresses
 * (node-config's chain info only embeds a subset of them).
 */
export function saveCoreContracts(chainId: number | bigint, coreContracts: CoreContracts): void {
  try {
    const filePath = coreContractsFilePath(chainId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(coreContracts, null, 2));
  } catch (error) {
    // Best-effort: losing this file only means core contracts must be
    // reconstructed from the deployment tx hash on next start.
    console.error('Failed to persist core contracts:', error);
  }
}

/**
 * Load persisted core contracts for a chain, if present.
 */
export function loadCoreContracts(chainId: number | bigint): CoreContracts | null {
  try {
    const filePath = coreContractsFilePath(chainId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CoreContracts;
  } catch {
    return null;
  }
}

/**
 * Load chain data from disk (node-config.json or discovered config files)
 */
export function loadChainDataFromDisk(): ChainData | null {
  let configPath = getNodeConfigPath();

  // If the default config file doesn't exist, try to discover others
  if (!fs.existsSync(configPath)) {
    const discoveredConfigs = discoverNodeConfigs();
    if (discoveredConfigs.size === 0) {
      return null;
    }

    // Use the first discovered config file
    // Prefer 'node-config' if available, otherwise use first found
    configPath = discoveredConfigs.get('node-config') || discoveredConfigs.values().next().value;
  }

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const nodeConfig: NodeConfig = JSON.parse(raw);

    // Extract chainConfig from node config
    const chainConfig = extractChainConfigFromNodeConfig(nodeConfig);
    if (!chainConfig) {
      return null;
    }

    // Create default node config paths
    const nodeConfigPaths = createNodeConfigPaths();

    // Use discovery logic to find all available config files
    const discoveredConfigs = discoverNodeConfigs();

    // Map discovered configs to NodeType
    for (const [name, path] of discoveredConfigs.entries()) {
      if (name.includes('malicious')) {
        nodeConfigPaths.set(NodeType.MALICIOUS, path);
      } else if (name.includes('honest')) {
        nodeConfigPaths.set(NodeType.HONEST, path);
      } else if (name === 'node-config') {
        nodeConfigPaths.set(NodeType.MAIN, path);
      }
    }

    // Restore core contracts persisted at deployment time, if available
    const coreContracts = loadCoreContracts(chainConfig.chainId) ?? undefined;

    return {
      chainConfig,
      nodeConfig,
      nodeConfigPaths,
      coreContracts,
    };
  } catch (error) {
    console.error('Failed to load chain data from disk:', error);
    return null;
  }
}

/**
 * Save node config for specific type
 */
export function saveNodeConfigForType(type: NodeType, nodeConfig: NodeConfig): void {
  const configPath = getNodeConfigPathForType(type);

  try {
    fs.writeFileSync(configPath, JSON.stringify(nodeConfig, null, 2));
  } catch (error) {
    throw new Error(
      `Failed to save node config for ${type}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
