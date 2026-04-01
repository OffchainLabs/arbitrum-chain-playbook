/**
 * Arbitrum SDK Setup Utilities
 *
 * This module provides utilities for registering custom Arbitrum networks
 * with the @arbitrum/sdk. This is required when working with custom-deployed
 * chains that the SDK doesn't recognize by default.
 */

import { registerCustomArbitrumNetwork, getArbitrumNetworks } from '@arbitrum/sdk';
import type { CoreContracts } from '@arbitrum/chain-sdk';

/**
 * Check if a network with the given chainId is already registered in the SDK.
 */
export function isNetworkRegistered(chainId: number): boolean {
  const networks = getArbitrumNetworks();
  return networks.some((network) => network.chainId === chainId);
}

/**
 * Ensure the custom network is registered with Arbitrum SDK.
 * If already registered, this function does nothing.
 *
 * @param chainId - The chain ID of the custom network
 * @param parentChainId - The chain ID of the parent chain (e.g., 421614 for Arbitrum Sepolia)
 * @param coreContracts - The core contracts deployed for this chain
 * @param confirmPeriodBlocks - The challenge period in blocks (default: 20)
 */
export function ensureCustomNetworkRegistered(
  chainId: number,
  parentChainId: number,
  coreContracts: CoreContracts,
  confirmPeriodBlocks: number = 20,
): void {
  // Check if network is already registered using SDK's native API
  if (isNetworkRegistered(chainId)) {
    return;
  }

  // Register the custom network
  const customNetwork = {
    chainId: chainId,
    parentChainId: parentChainId,
    confirmPeriodBlocks: confirmPeriodBlocks,
    ethBridge: {
      bridge: coreContracts.bridge,
      inbox: coreContracts.inbox,
      outbox: coreContracts.outbox,
      rollup: coreContracts.rollup,
      sequencerInbox: coreContracts.sequencerInbox,
    },
    isCustom: true,
    isTestnet: true,
    name: `CustomChain-${chainId}`,
  };

  registerCustomArbitrumNetwork(customNetwork);
}
