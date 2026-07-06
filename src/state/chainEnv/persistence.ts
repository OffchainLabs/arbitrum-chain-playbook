/**
 * ChainEnv Persistence Module
 *
 * Handles saving and loading chain configuration to/from disk
 */

import fs from 'fs';
import path from 'path';
import { ChainConfig, NodeConfig } from '@arbitrum/chain-sdk';
import { NodeType } from '../../types/index.js';
import { CoreContracts, NodeConfigPaths } from './types.js';
import { discoverNodeConfigs } from '../../utils/nodeConfigUtils.js';
import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_MALICIOUS_FILENAME,
  NODE_CONFIG_HONEST_FILENAME,
} from '../../types/constants.js';

/**
 * Get the path to the main node config file
 */
export function getNodeConfigFilePath(): string {
  return path.join(process.cwd(), NODE_CONFIG_FILENAME);
}

/**
 * Get the path to node config file for specific node type
 */
export function getNodeConfigFilePathForType(type: NodeType): string {
  const basePath = process.cwd();
  switch (type) {
    case NodeType.MAIN:
      return path.join(basePath, NODE_CONFIG_FILENAME);
    case NodeType.MALICIOUS:
      return path.join(basePath, NODE_CONFIG_MALICIOUS_FILENAME);
    case NodeType.HONEST:
      return path.join(basePath, NODE_CONFIG_HONEST_FILENAME);
    default:
      return path.join(basePath, NODE_CONFIG_FILENAME);
  }
}

/**
 * Check if node config file exists
 * Uses the new discovery logic to find any valid configuration files
 */
export function nodeConfigFileExists(): boolean {
  // First check the default location
  if (fs.existsSync(getNodeConfigFilePath())) {
    return true;
  }

  // Use discovery logic to find any available config files
  const discoveredConfigs = discoverNodeConfigs();
  return discoveredConfigs.size > 0;
}

/**
 * Create default node config paths map
 */
export function createDefaultNodeConfigPaths(): NodeConfigPaths {
  const paths = new Map<NodeType, string>();
  paths.set(NodeType.MAIN, getNodeConfigFilePathForType(NodeType.MAIN));
  return paths;
}

/**
 * Data structure for persisted chain data
 */
interface PersistedData {
  chainConfig: ChainConfig;
  nodeConfig: NodeConfig;
  coreContracts?: CoreContracts;
  nodeConfigPaths: NodeConfigPaths;
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
 * Load chain data from disk (node-config.json or discovered config files)
 */
export function loadChainDataFromDisk(): PersistedData | null {
  let configPath = getNodeConfigFilePath();

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
    const nodeConfigPaths = createDefaultNodeConfigPaths();

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

    return {
      chainConfig,
      nodeConfig,
      nodeConfigPaths,
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
  const configPath = getNodeConfigFilePathForType(type);

  try {
    fs.writeFileSync(configPath, JSON.stringify(nodeConfig, null, 2));
  } catch (error) {
    throw new Error(
      `Failed to save node config for ${type}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
