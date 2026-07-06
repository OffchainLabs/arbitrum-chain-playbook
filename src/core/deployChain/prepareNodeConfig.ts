import { NodeConfig } from '@arbitrum/chain-sdk';
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
