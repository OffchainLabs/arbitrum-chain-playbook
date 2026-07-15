/**
 * Env-derived application configuration.
 *
 * Plain functions (evaluated on each call so .env mutations during a session
 * are picked up). Static tunables live in types/constants.ts and are imported
 * directly — do not wrap them here.
 */

import { getParentChainKey, getParentChainDisplayName, isDefaultParentChain } from '../utils/parentChain.js';

export interface AppConfig {
  parentChainRpc: string | undefined;
  parentChainKey: string;
  parentChainDisplayName: string;
  isDefaultParentChain: boolean;
  chainRpc: string | undefined;
  deploymentTxHash: string | undefined;
  deployerPrivateKey: string | undefined;
}

export function getAppConfig(): AppConfig {
  return {
    parentChainRpc: process.env.PARENT_CHAIN_RPC,
    parentChainKey: getParentChainKey(),
    parentChainDisplayName: getParentChainDisplayName(),
    isDefaultParentChain: isDefaultParentChain(),
    chainRpc: process.env.CHAIN_RPC,
    deploymentTxHash: process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH,
    deployerPrivateKey: process.env.MAIN_PRIVATE_KEY,
  };
}

export function isChainModeAvailable(): boolean {
  return !!process.env.PARENT_CHAIN_RPC;
}

export function isRemoteRpcModeAvailable(): boolean {
  return !!process.env.PARENT_CHAIN_RPC && !!process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH && !!process.env.CHAIN_RPC;
}

export function hasDeployerKey(): boolean {
  return !!process.env.MAIN_PRIVATE_KEY;
}

export function getDeploymentTxHash(): `0x${string}` | undefined {
  return process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH as `0x${string}` | undefined;
}
