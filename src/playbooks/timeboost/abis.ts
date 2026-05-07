/**
 * ABI bundles needed by the Timeboost playbook. Loaded from the vendored JSON
 * artifacts under `./artifacts/`. We import via `createRequire` because
 * `import ... from '*.json'` is not stably supported across our Node target
 * (18 / 23) and ts-node's ESM loader.
 */

import { createRequire } from 'node:module';
import type { Abi, Hex } from 'viem';

const require_ = createRequire(import.meta.url);

interface ArtifactJson {
  abi: Abi;
  bytecode: Hex | string;
}

function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = require_(`./artifacts/${name}.json`) as ArtifactJson;
  const bc = (a.bytecode ?? '') as string;
  if (!bc.startsWith('0x')) throw new Error(`Artifact ${name}: bytecode missing 0x prefix`);
  return { abi: a.abi, bytecode: bc as Hex };
}

export const expressLaneAuctionArtifact = loadArtifact('ExpressLaneAuction');
export const transparentProxyArtifact = loadArtifact('TransparentUpgradeableProxy');
export const proxyAdminArtifact = loadArtifact('ProxyAdmin');

/** Minimal ERC20 ABI used wherever we need to call approve / balanceOf / transfer. */
export const erc20MinimalAbi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const satisfies Abi;
