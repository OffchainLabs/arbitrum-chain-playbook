import { Chain, PublicClient } from 'viem';
import { NodeConfig, PrepareNodeConfigParams, prepareNodeConfig } from '@arbitrum/chain-sdk';
import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import { ChainData, NodeType } from '../types/index.js';
import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_MALICIOUS_FILENAME,
  NODE_CONFIG_HONEST_FILENAME,
  DEFAULT_CHAIN_NAME,
} from '../types/constants.js';
import { SenderAccount, SenderRole } from '../state/sendersEnv/index.js';
import { parseDeploymentTx } from './deploymentTx.js';
config();

// Get base config file path (MAIN type)
export const getNodeConfigPath = (): string => path.join(process.cwd(), NODE_CONFIG_FILENAME);

// Get config file path for specific NodeType
export const getNodeConfigPathForType = (type: NodeType): string => {
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
};

// Initialize nodeConfigPaths Map with MAIN type by default
export const createNodeConfigPaths = (): Map<NodeType, string> => {
  const paths = new Map<NodeType, string>();
  paths.set(NodeType.MAIN, getNodeConfigPathForType(NodeType.MAIN));
  return paths;
};

// Get config file patterns for discovery
const getConfigFilePattern = (): string[] => {
  return ['node-config.json', 'node-config-*.json', 'configs/node-*.json'];
};

// Convert a simple filename glob (only `*` supported) to an anchored RegExp.
// Escape regex metacharacters first so the `.*` we substitute for `*` survives.
export const filenameGlobToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
};

// Discover node configurations
export const discoverNodeConfigs = (): Map<string, string> => {
  const configs = new Map<string, string>();
  const patterns = getConfigFilePattern();

  for (const pattern of patterns) {
    try {
      // Use fs.readdirSync with pattern matching instead of glob
      const cwd = process.cwd();

      if (!pattern.includes('*')) {
        // Exact filename, e.g. node-config.json
        const filePath = path.join(cwd, pattern);
        if (fs.existsSync(filePath)) {
          configs.set(path.basename(pattern, '.json'), path.resolve(filePath));
        }
      } else {
        // Glob pattern; may carry a directory component, e.g. configs/node-*.json
        const dirPath = path.dirname(pattern);
        const fileName = path.basename(pattern);
        const fullDirPath = dirPath === '.' ? cwd : path.join(cwd, dirPath);

        if (fs.existsSync(fullDirPath)) {
          const files = fs.readdirSync(fullDirPath);
          const regex = filenameGlobToRegExp(fileName);

          files.forEach((file) => {
            if (regex.test(file)) {
              const fullPath = path.join(fullDirPath, file);
              configs.set(path.basename(file, '.json'), path.resolve(fullPath));
            }
          });
        }
      }
    } catch (error) {
      // Continue if pattern fails
    }
  }

  return configs;
};

function getRpcUrl(chain: Chain) {
  return chain.rpcUrls.default.http[0];
}

const ensureNodeObject = (nodeConfig: NodeConfig): Record<string, unknown> => {
  if (!nodeConfig.node || typeof nodeConfig.node !== 'object') {
    (nodeConfig as any).node = {};
  }
  return nodeConfig.node as unknown as Record<string, unknown>;
};

const ensureChildObject = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
  if (!parent[key] || typeof parent[key] !== 'object') {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
};

// Apply shared defaults whenever a fresh node config is generated from chain data. (Make the node can start immediately)
export function applyGeneratedNodeConfigDefaults(nodeConfig: NodeConfig): NodeConfig {
  // Skip unnecessary deployment re-checks for generated configs.
  (nodeConfig as Record<string, unknown>)['ensure-rollup-deployment'] = false;

  // Keep BoLD state reads pinned to latest block by default.
  const node = ensureNodeObject(nodeConfig);
  const bold = ensureChildObject(node, 'bold');
  bold['rpc-block-number'] = 'latest';

  return nodeConfig;
}

export async function generateNodeConfiguration(
  txHash: `0x${string}`,
  parentChain: Chain,
  parentChainPublicClient: PublicClient,
  nodeAccounts: SenderAccount[],
  parentChainRpcUrl?: string,
): Promise<ChainData> {
  // get the validator private keys from the node accounts
  const validatorPrivateKeys = nodeAccounts
    .filter((account) => account.role === SenderRole.Validator)
    .map((account) => account.privateKey);
  // get the batch poster private key from the node accounts
  const batchPosterPrivateKeys = nodeAccounts
    .filter((account) => account.role === SenderRole.BatchPoster)
    .map((account) => account.privateKey);

  // Decode the deployment transaction (chainConfig, coreContracts, stakeToken)
  const { chainConfig, coreContracts, rollupConfig } = await parseDeploymentTx(parentChainPublicClient, txHash);

  // prepare the node config
  // Use provided parentChainRpcUrl, or fallback to chain's default RPC
  const nodeConfigParameters: PrepareNodeConfigParams = {
    chainName: DEFAULT_CHAIN_NAME,
    chainConfig,
    coreContracts,
    batchPosterPrivateKey: batchPosterPrivateKeys[0],
    validatorPrivateKey: validatorPrivateKeys[0],
    stakeToken: rollupConfig.stakeToken,
    parentChainId: parentChain.id as 1 | 1337 | 412346 | 42161 | 42170 | 8453 | 11155111 | 421614 | 84532, // Chain-sdk only supports these parent chain ids
    parentChainRpcUrl: parentChainRpcUrl || getRpcUrl(parentChain),
  };

  const nodeConfig = applyGeneratedNodeConfigDefaults(prepareNodeConfig(nodeConfigParameters));

  const nodeConfigPaths = createNodeConfigPaths();

  return { nodeConfig, nodeConfigPaths, chainConfig, coreContracts };
}

// Configure main node with feed output enabled (for other nodes to subscribe)
export function overwriteToNodeConfigForMainNode(nodeConfig: NodeConfig): NodeConfig {
  const node = ensureNodeObject(nodeConfig);

  // Enable feed output so other nodes can subscribe to block updates
  const feed = ensureChildObject(node, 'feed');
  const output = ensureChildObject(feed, 'output');
  output['enable'] = true;
  output['addr'] = '0.0.0.0';
  output['port'] = '9642';

  return nodeConfig;
}

// Make the validator respond to the assertions faster
export function overwriteToNodeConfigForFastValidator(nodeConfig: NodeConfig): NodeConfig {
  // Ensure node.bold exists so subsequent overwrites always apply
  const node = ensureNodeObject(nodeConfig);
  const bold = ensureChildObject(node, 'bold');

  // --node.bold.assertion-confirming-interval 10s
  // --node.bold.assertion-posting-interval 10s
  // --node.bold.assertion-scanning-interval 10s
  bold['assertion-confirming-interval'] = '10s';
  bold['assertion-posting-interval'] = '10s';
  bold['assertion-scanning-interval'] = '10s';
  //--node.bold.rpc-block-number latest
  // --node.bold.state-provider-config.check-batch-finality false
  bold['rpc-block-number'] = 'latest';
  if (bold['state-provider-config'] && typeof bold['state-provider-config'] === 'object') {
    (bold['state-provider-config'] as Record<string, unknown>)['check-batch-finality'] = 'false';
  } else {
    bold['state-provider-config'] = { 'check-batch-finality': 'false' };
  }

  return nodeConfig;
}

// Make the batch poster post batches faster
export function overwriteToNodeConfigForFastBatchPoster(nodeConfig: NodeConfig): NodeConfig {
  // --node.batch-poster.max-delay 5s
  const node = ensureNodeObject(nodeConfig);
  const batchPoster = ensureChildObject(node, 'batch-poster');
  batchPoster['max-delay'] = '5s';
  // --node.batch-poster.l1-block-bound latest
  batchPoster['l1-block-bound'] = 'latest';
  return nodeConfig;
}

// Configure node as an honest validator (challenger, not sequencer/batch-poster)
// Uses MakeNodes strategy but with very long assertion-posting-interval to avoid creating new assertions
// This allows the honest validator to participate in challenges without competing for assertion creation
export function overwriteToNodeConfigForHonestValidator(
  nodeConfig: NodeConfig,
  mainNodeHttpPort: number = 8449,
): NodeConfig {
  const node = ensureNodeObject(nodeConfig);

  // Disable sequencer - honest validator is not a sequencer
  node['sequencer'] = false;

  // Disable delayed-sequencer
  const delayedSequencer = ensureChildObject(node, 'delayed-sequencer');
  delayedSequencer['enable'] = false;

  // Disable batch-poster - honest validator is not a batch poster
  const batchPoster = ensureChildObject(node, 'batch-poster');
  batchPoster['enable'] = false;

  // Set staker to MakeNodes strategy (required for challenge participation)
  const staker = ensureChildObject(node, 'staker');
  staker['enable'] = true;
  staker['strategy'] = 'MakeNodes';

  // Configure bold for fast challenge response
  const bold = ensureChildObject(node, 'bold');
  bold['rpc-block-number'] = 'latest';
  bold['assertion-posting-interval'] = '10s';
  bold['minimum-gap-to-parent-assertion'] = '10s';
  bold['assertion-scanning-interval'] = '10s';
  bold['assertion-confirming-interval'] = '10s';
  const stateProviderConfig = ensureChildObject(bold, 'state-provider-config');
  stateProviderConfig['check-batch-finality'] = 'false';

  // Set dangerous flags
  const dangerous = ensureChildObject(node, 'dangerous');
  dangerous['no-sequencer-coordinator'] = true;

  // Disable rpc-aggregator in data-availability - it's only for Batch Poster mode
  // Honest validators only need rest-aggregator to read DA data
  if (node['data-availability'] && typeof node['data-availability'] === 'object') {
    const dataAvailability = node['data-availability'] as Record<string, unknown>;
    if (dataAvailability['rpc-aggregator'] && typeof dataAvailability['rpc-aggregator'] === 'object') {
      (dataAvailability['rpc-aggregator'] as Record<string, unknown>)['enable'] = false;
    }
  }

  // Configure feed input to receive from main node's feed output (port 9642)
  const feed = ensureChildObject(node, 'feed');
  const feedInput = ensureChildObject(feed, 'input');
  feedInput['url'] = 'ws://host.docker.internal:9642';

  // Configure execution settings
  if (!nodeConfig.execution || typeof nodeConfig.execution !== 'object') {
    (nodeConfig as any).execution = {};
  }
  const execution = nodeConfig.execution as Record<string, unknown>;

  // Set forwarding target to main node
  execution['forwarding-target'] = `http://host.docker.internal:${mainNodeHttpPort}`;

  // Disable execution sequencer
  const execSequencer = ensureChildObject(execution, 'sequencer');
  execSequencer['enable'] = false;

  return nodeConfig;
}

// Make the validator running the incorrect Wasm module
export function overwriteToNodeConfigForIncorrectWasmValidator(nodeConfig: NodeConfig): NodeConfig {
  // Make the validator respond to the assertions faster
  nodeConfig = overwriteToNodeConfigForFastValidator(nodeConfig);
  // --node.staker.dangerous.ignore-rollup-wasm-module-root true
  const node = ensureNodeObject(nodeConfig);
  const staker = ensureChildObject(node, 'staker');
  const dangerous = ensureChildObject(staker, 'dangerous');
  dangerous['ignore-rollup-wasm-module-root'] = true;
  return nodeConfig;
}

// Configure malicious validator with ReadInboxMessage bit-flip mode (Challenge Demo)
// Uses validation.wasm.malicious-mode to create deterministic divergence
export function overwriteToNodeConfigForMaliciousValidator(nodeConfig: NodeConfig): NodeConfig {
  // Apply fast validator and fast batch poster settings
  nodeConfig = overwriteToNodeConfigForFastValidator(nodeConfig);
  nodeConfig = overwriteToNodeConfigForFastBatchPoster(nodeConfig);

  // Add malicious-mode config (ReadInboxMessage bit-flip)
  if (!nodeConfig.validation || typeof nodeConfig.validation !== 'object') {
    (nodeConfig as any).validation = {};
  }
  const validation = (nodeConfig as any).validation;
  const wasm = ensureChildObject(validation, 'wasm');
  wasm['malicious-mode'] = true;
  wasm['allow-gas-estimation-failure'] = true;

  return nodeConfig;
}

// Configure malicious mint validator with BlockValidator enabled and local WASM support
// Used by the Malicious Mint Demo: enables block validation with local WASM,
// skips on-chain wasmModuleRoot verification, and applies fast validator + fast batch poster settings.
export function overwriteToNodeConfigForMaliciousMint(nodeConfig: NodeConfig): NodeConfig {
  // Apply fast validator and fast batch poster settings
  nodeConfig = overwriteToNodeConfigForFastValidator(nodeConfig);
  nodeConfig = overwriteToNodeConfigForFastBatchPoster(nodeConfig);

  const node = ensureNodeObject(nodeConfig);
  const staker = ensureChildObject(node, 'staker');
  const dangerous = ensureChildObject(staker, 'dangerous');

  // Enable BlockValidator (set to false to enable)
  dangerous['without-block-validator'] = false;
  // Skip on-chain wasmModuleRoot verification
  dangerous['ignore-rollup-wasm-module-root'] = true;

  // Explicitly enable BlockValidator with local WASM
  const blockValidator = ensureChildObject(node, 'block-validator');
  blockValidator['enable'] = true;
  blockValidator['current-module-root'] = 'latest';
  blockValidator['pending-upgrade-module-root'] = 'latest';

  // Allow using local WASM module roots
  if (!nodeConfig.validation || typeof nodeConfig.validation !== 'object') {
    (nodeConfig as any).validation = {};
  }
  const validation = (nodeConfig as any).validation;
  const wasm = ensureChildObject(validation, 'wasm');
  wasm['allowed-wasm-module-roots'] = ['/home/user/target/machines'];

  return nodeConfig;
}

// Delete node.bold.strategy (e.g. "MakeNodes") from the node config
export function overwriteToNodeConfigForDeletingBoldStrategy(nodeConfig: NodeConfig): NodeConfig {
  if (!nodeConfig.node || typeof nodeConfig.node !== 'object') return nodeConfig;

  const bold = (nodeConfig.node as any)['bold'];
  if (!bold || typeof bold !== 'object') return nodeConfig;

  delete (bold as Record<string, unknown>)['strategy'];

  // If bold becomes empty after deleting strategy, remove the bold object entirely.
  if (Object.keys(bold as Record<string, unknown>).length === 0) {
    delete (nodeConfig.node as any)['bold'];
  }

  return nodeConfig;
}
