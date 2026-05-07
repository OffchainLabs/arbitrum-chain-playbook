/**
 * EIP-191 signer for Timeboost express-lane submissions.
 *
 * Wire format mirrors nitro/timeboost/types.go:ExpressLaneSubmission.ToMessageBytes
 * exactly — any drift will be rejected by the sequencer's signature recovery
 * (see nitro/timeboost/types.go:Sender at lines 233-261).
 *
 * Layout of the message bytes that get personal-signed:
 *   domainValue (32) | chainId (32 BE padded) | auctionContractAddress (20)
 *   | round (uint64 BE, 8) | sequenceNumber (uint64 BE, 8) | rlpTx (variable)
 *
 * domainValue = keccak256("TIMEBOOST_BID")  (nitro/timeboost/auctioneer.go:61)
 *
 * The signature is then constructed as a standard `personal_sign`:
 *   keccak256("\x19Ethereum Signed Message:\n" + len(msg) + msg) -> ECDSA sign
 */

import {
  type Account,
  type Address,
  type Hex,
  type LocalAccount,
  bytesToHex,
  concat,
  keccak256,
  numberToBytes,
  pad,
  toBytes,
  toHex,
} from 'viem';

const TIMEBOOST_DOMAIN_LABEL = 'TIMEBOOST_BID';

/** Cached keccak256("TIMEBOOST_BID"). */
let cachedDomainValue: Hex | null = null;

export function timeboostDomainValue(): Hex {
  if (cachedDomainValue === null) {
    cachedDomainValue = keccak256(toBytes(TIMEBOOST_DOMAIN_LABEL));
  }
  return cachedDomainValue;
}

export interface BuildSubmissionMessageInput {
  chainId: bigint;
  auctionContractAddress: Address;
  round: bigint;
  sequenceNumber: bigint;
  /** Already RLP-encoded signed transaction bytes (the output of viem.signTransaction). */
  rlpTx: Hex;
}

/**
 * Build the exact byte payload that gets personal-signed.
 * Pure function — no I/O — so it's trivially unit-testable against Nitro
 * test vectors.
 */
export function buildSubmissionMessageBytes(input: BuildSubmissionMessageInput): Hex {
  const chainIdPadded = pad(numberToBytes(input.chainId), { size: 32, dir: 'left' });
  const roundBuf = numberToBytes(input.round, { size: 8 });
  const seqBuf = numberToBytes(input.sequenceNumber, { size: 8 });

  return bytesToHex(
    concat([
      toBytes(timeboostDomainValue()),
      chainIdPadded,
      toBytes(input.auctionContractAddress),
      roundBuf,
      seqBuf,
      toBytes(input.rlpTx),
    ]),
  );
}

/**
 * Sign an express-lane submission with EIP-191 personal_sign semantics.
 *
 * Note: viem's `account.signMessage({ message: { raw: ... } })` already prepends
 * the EIP-191 prefix and hashes — we just feed it the raw bytes Nitro will reconstruct.
 */
export async function signExpressLaneSubmission(account: Account, input: BuildSubmissionMessageInput): Promise<Hex> {
  const messageBytes = buildSubmissionMessageBytes(input);

  // viem's signMessage with `raw` prepends "\x19Ethereum Signed Message:\n<len>"
  // and computes keccak256 before signing — identical to nitro/timeboost/types.go:246.
  const local = account as LocalAccount<string>;
  if (typeof local.signMessage !== 'function') {
    throw new Error(
      'Express-lane signer requires a LocalAccount (e.g. privateKeyToAccount). ' +
        'Browser-injected or JSON-RPC accounts cannot deterministically sign the raw payload.',
    );
  }

  return local.signMessage({ message: { raw: messageBytes } });
}

/**
 * Convenience: convert a bigint to its standard hex representation
 * compatible with the sequencer's `hexutil.Big` / `hexutil.Uint64` decoders.
 */
export function bigintToRpcHex(value: bigint): Hex {
  return toHex(value);
}
