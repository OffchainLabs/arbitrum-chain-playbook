/**
 * Negative-path demo: a non-controller submits to `timeboost_sendExpressLaneTransaction`
 * and we expect to see the sentinel error `NOT_EXPRESS_LANE_CONTROLLER`
 * (defined in nitro/timeboost/errors.go:17, raised at express_lane_service.go:113).
 *
 * This is an important teaching moment — without a visible failure, the audience
 * has no way to tell that the sequencer actually enforces the controller right.
 */

import {
  type Address,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { submitExpressLaneTransaction, TimeboostRpcError } from './expressLaneRunner.js';
import type { UnauthorizedAttemptRecord } from './types.js';

let log = {
  section: (m: string) => console.log('\n▸', m, '\n'),
  info: (m: string) => console.log('ℹ', m),
  warn: (m: string) => console.log('⚠', m),
  success: (m: string) => console.log('✔', m),
};

export function setUnauthorizedRunnerLogger(l: typeof log): void {
  log = l;
}

const SENTINEL = 'NOT_EXPRESS_LANE_CONTROLLER';

export interface RunUnauthorizedAttemptInput {
  /** A LocalAccount that is NOT the current round's express lane controller. */
  unauthorizedAccount: LocalAccount<string>;
  childClient: PublicClient;
  chainId: number;
  round: bigint;
  auctionContractAddress: Address;
  sequencerRpcUrl: string;
  /** Recipient of the underlying tx — content is irrelevant; demo only cares about rejection. */
  to: Address;
}

/**
 * Run the unauthorized attempt and return a structured record.
 * Always resolves (even on success — which would itself be a "negative finding").
 */
export async function runUnauthorizedAttempt(
  input: RunUnauthorizedAttemptInput,
): Promise<UnauthorizedAttemptRecord> {
  const {
    unauthorizedAccount,
    childClient,
    chainId,
    round,
    auctionContractAddress,
    sequencerRpcUrl,
    to,
  } = input;

  log.section('Unauthorized express-lane submission');
  log.info(`Sender ${unauthorizedAccount.address} is NOT the controller for round ${round}.`);
  log.info('Expecting the sequencer to reject with NOT_EXPRESS_LANE_CONTROLLER.');

  const attemptedAtMs = Date.now();

  try {
    await submitExpressLaneTransaction({
      controllerAccount: unauthorizedAccount,
      childClient,
      chainId,
      round,
      auctionContractAddress,
      sequencerRpcUrl,
      to,
      label: 'unauthorized',
    });

    // Reaching here means the sequencer accepted the submission. That's
    // unexpected and worth highlighting — the demo can still proceed.
    log.warn('Unauthorized submission was NOT rejected. Configuration is likely off.');
    return {
      attemptedAtMs,
      attempterAddress: unauthorizedAccount.address,
      round: Number(round),
      errorMessage: '<no error — sequencer accepted the submission>',
      recognised: false,
    };
  } catch (e) {
    const errorMessage = extractMessage(e);
    const recognised = errorMessage.includes(SENTINEL);

    if (recognised) {
      log.success(`Sequencer rejected with the expected error: "${SENTINEL}"`);
    } else {
      log.warn(`Submission was rejected, but with an unexpected message: "${errorMessage}"`);
    }

    return {
      attemptedAtMs,
      attempterAddress: unauthorizedAccount.address,
      round: Number(round),
      errorMessage,
      recognised,
    };
  }
}

function extractMessage(e: unknown): string {
  if (e instanceof TimeboostRpcError) return e.rpcMessage;
  if (e instanceof Error) return e.message;
  return String(e);
}
