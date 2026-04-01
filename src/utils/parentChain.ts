import { type Chain } from 'viem';
import { arbitrumSepolia, arbitrum, arbitrumNova, mainnet, sepolia, base, baseSepolia } from 'viem/chains';

const SUPPORTED_CHAINS: Record<string, Chain> = {
  'arbitrum-sepolia': arbitrumSepolia,
  arbitrum: arbitrum,
  'arbitrum-nova': arbitrumNova,
  ethereum: mainnet,
  sepolia: sepolia,
  base: base,
  'base-sepolia': baseSepolia,
};

const DEFAULT_PARENT_CHAIN_KEY = 'arbitrum-sepolia';

export function getSupportedChainNames(): string[] {
  return Object.keys(SUPPORTED_CHAINS);
}

export function getParentChainKey(): string {
  const raw = process.env.PARENT_CHAIN?.trim().toLowerCase();
  return raw || DEFAULT_PARENT_CHAIN_KEY;
}

export function getParentChain(): Chain {
  const key = getParentChainKey();
  const chain = SUPPORTED_CHAINS[key];

  if (!chain) {
    const supported = getSupportedChainNames().join(', ');
    throw new Error(
      `Invalid PARENT_CHAIN value: "${process.env.PARENT_CHAIN}". ` +
        `Supported values: ${supported}. ` +
        `Remove PARENT_CHAIN from .env to use the default (${DEFAULT_PARENT_CHAIN_KEY}).`,
    );
  }

  return chain;
}

export function getParentChainDisplayName(): string {
  return getParentChain().name;
}

export function isDefaultParentChain(): boolean {
  return getParentChainKey() === DEFAULT_PARENT_CHAIN_KEY;
}
