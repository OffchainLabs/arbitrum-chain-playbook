/**
 * Zod schemas for the headless / scripted runner.
 *
 * Top-level ScriptSchema validates the YAML/JSON envelope. Per-command
 * schemas validate `params` once we know which playbook command we're
 * dispatching to. ETH amounts are accepted as decimal strings or numbers
 * and converted to bigint wei via parseEther.
 */

import { z } from 'zod';
import { parseEther } from 'viem';

const ethAmount = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    return parseEther(String(value));
  } catch {
    ctx.addIssue({ code: 'custom', message: `Invalid ETH amount: ${String(value)}` });
    return z.NEVER;
  }
});

export const OperationModeEnum = z.enum(['chain', 'devnode', 'remote']);
export type ScriptOperationMode = z.infer<typeof OperationModeEnum>;

export const ChainRestorePolicyEnum = z.enum(['auto', 'fresh', 'reuse']);
export type ChainRestorePolicy = z.infer<typeof ChainRestorePolicyEnum>;

export const OrphanContainerPolicyEnum = z.enum(['warn', 'stop']);
export type OrphanContainerPolicy = z.infer<typeof OrphanContainerPolicyEnum>;

export const ScriptSchema = z.object({
  mode: OperationModeEnum,
  playbook: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  /**
   * Headless-only chain restore behavior.
   * - auto: infer from playbook metadata
   * - fresh: skip restoring existing CHAIN_DEPLOYMENT_TRANSACTION_HASH/node-config.json
   * - reuse: preserve the existing restore validation behavior
   */
  chainRestorePolicy: ChainRestorePolicyEnum.optional().default('auto'),
  /**
   * Headless-only handling for pre-existing nitro-* containers.
   * warn is intentionally conservative so interactive users' containers are
   * never stopped unless a script explicitly opts into stop.
   */
  orphanContainerPolicy: OrphanContainerPolicyEnum.optional().default('warn'),
  /** Hard timeout for the run. Cancels the OperationContext when exceeded. */
  timeoutSeconds: z.number().int().positive().optional(),
});
export type ScriptDocument = z.infer<typeof ScriptSchema>;

export const MaliciousMintParamsSchema = z
  .object({
    mainDepositAmount: ethAmount.optional(),
    hackerDepositAmount: ethAmount.optional(),
    hackerFundingAmount: ethAmount.optional(),
  })
  .strict();
export type MaliciousMintHeadlessInput = z.infer<typeof MaliciousMintParamsSchema>;

export const BoldChallengeParamsSchema = z
  .object({
    maxWaitSeconds: z.number().int().positive().optional(),
    pollIntervalMs: z.number().int().positive().optional(),
    delayedMessageCount: z.number().int().nonnegative().optional(),
    delayedMessageAmount: ethAmount.optional(),
    childChainTxCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BoldChallengeHeadlessInput = z.infer<typeof BoldChallengeParamsSchema>;

export const TimeboostRunFullDemoParamsSchema = z
  .object({
    /** Add the bid-cancellation round (default false): re-bidding lower on the same controller flips the winner. */
    bidCancellation: z.boolean().optional().default(false),
  })
  .strict();
export type TimeboostRunFullDemoHeadlessInput = z.infer<typeof TimeboostRunFullDemoParamsSchema>;
