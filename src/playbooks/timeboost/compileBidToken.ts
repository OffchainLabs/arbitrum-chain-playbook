/**
 * Checked-in artifact of the minimal mintable ERC20 used as the Timeboost
 * bidding token.
 *
 * The Solidity source and compile settings live in
 * scripts/genBidTokenArtifact.ts; regenerate with `yarn gen:bid-token`
 * (solc is a devDependency only — nothing compiles at runtime). The artifact
 * records the exact solc version so the provenance concern that motivated
 * the previous on-the-fly compile is preserved.
 */

import { createRequire } from 'node:module';
import type { Hex } from 'viem';

const require_ = createRequire(import.meta.url);

interface CompiledArtifact {
  abi: unknown[];
  bytecode: Hex;
}

export function compileMintableERC20(): CompiledArtifact {
  const artifact = require_('./artifacts/MintableERC20.json') as { abi: unknown[]; bytecode: string };
  if (!artifact.bytecode?.startsWith('0x')) {
    throw new Error('MintableERC20 artifact is malformed — regenerate with `yarn gen:bid-token`.');
  }
  return { abi: artifact.abi, bytecode: artifact.bytecode as Hex };
}
