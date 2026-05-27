/**
 * ABI bundles needed by the Timeboost playbook.
 *
 * No artifacts are vendored under this directory. Everything is imported
 * straight from `node_modules`:
 *   - ExpressLaneAuction (impl + events)  ← @arbitrum/nitro-contracts
 *   - TransparentUpgradeableProxy + ProxyAdmin  ← @openzeppelin/contracts
 *   - IERC20 (approve / transfer / balanceOf / ...)  ← @arbitrum/sdk
 *
 * The only hand-written fragment we still keep is the single-method `mint(address,uint256)`
 * ABI for our compiled-on-the-fly MintableERC20 (see compileBidToken.ts) — IERC20 has no
 * mint method, and pulling the full OpenZeppelin ERC20PresetMinterPauser ABI just for one
 * function is gratuitous. The bidding-token consumers concatenate `IERC20.abi` with this
 * fragment when they need to mint.
 */

import { createRequire } from 'node:module';
import { IERC20__factory } from '@arbitrum/sdk/dist/lib/abi/factories/IERC20__factory.js';
import type { Abi, Hex } from 'viem';

const require_ = createRequire(import.meta.url);

interface ArtifactJson {
  abi: Abi;
  bytecode: Hex | string;
}

function loadArtifact(path: string): { abi: Abi; bytecode: Hex } {
  const a = require_(path) as ArtifactJson;
  const bc = (a.bytecode ?? '') as string;
  if (!bc.startsWith('0x')) throw new Error(`Artifact ${path}: bytecode missing 0x prefix`);
  return { abi: a.abi, bytecode: bc as Hex };
}

export const expressLaneAuctionArtifact = loadArtifact(
  '@arbitrum/nitro-contracts/build/contracts/src/express-lane-auction/ExpressLaneAuction.sol/ExpressLaneAuction.json',
);
export const transparentProxyArtifact = loadArtifact(
  '@openzeppelin/contracts/build/contracts/TransparentUpgradeableProxy.json',
);
export const proxyAdminArtifact = loadArtifact('@openzeppelin/contracts/build/contracts/ProxyAdmin.json');

/** Standard ERC20 surface (approve / transfer / balanceOf / allowance / transferFrom / totalSupply). */
export const ierc20Abi = IERC20__factory.abi as unknown as Abi;

/**
 * Minimal `mint(address,uint256)` fragment for the playbook's MintableERC20.
 * Combine with `ierc20Abi` when a consumer needs both standard ERC20 and mint.
 */
export const mintableErc20MintFragment = [
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

/** Convenience: full bidding-token surface (IERC20 + mint). */
export const biddingTokenAbi: Abi = [...ierc20Abi, ...mintableErc20MintFragment];
