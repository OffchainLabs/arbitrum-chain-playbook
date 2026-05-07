/**
 * Phase 2: deploy the on-chain pieces of the Timeboost demo on the child chain.
 *
 *   1. MintableERC20 (compiled via solc) — the bidding token.
 *   2. ExpressLaneAuction implementation contract.
 *   3. ProxyAdmin (OZ 4.x style — the implementation owner of the proxy).
 *   4. TransparentUpgradeableProxy pointing at the impl, initialised via
 *      its constructor `_data` argument so there's no uninitialised window.
 *
 * Layout choice: separate ProxyAdmin contract owned by the deployer EOA, so
 * the deployer EOA itself can call implementation methods (e.g. roundTimingInfo)
 * without being routed to admin functions. Mirrors v2 plan §5 (Proxy admin).
 */

import {
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
} from 'viem';
import { expressLaneAuctionArtifact, proxyAdminArtifact, transparentProxyArtifact } from './abis.js';
import { compileMintableERC20 } from './compileBidToken.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default demo round timing — matches v2 plan §0 #1 (20 / 5 / 3). */
export interface RoundTimingConfig {
  roundDurationSeconds: number;
  auctionClosingSeconds: number;
  reserveSubmissionSeconds: number;
}

export const DEFAULT_DEMO_TIMING: RoundTimingConfig = {
  roundDurationSeconds: 20,
  auctionClosingSeconds: 5,
  reserveSubmissionSeconds: 3,
};

/** Closer-to-production timing matching the docs example. */
export const DOCS_DEFAULT_TIMING: RoundTimingConfig = {
  roundDurationSeconds: 60,
  auctionClosingSeconds: 15,
  reserveSubmissionSeconds: 15,
};

export interface DeployContractsInput {
  /** Deployer (must hold child chain ETH for gas). */
  deployer: LocalAccount<string>;
  /** Both clients for the child chain. */
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Address that will resolve auctions and hold AUCTIONEER_ROLE. */
  auctioneer: Address;
  /** Address that receives auction proceeds when `flushBeneficiaryBalance()` is called. */
  beneficiary: Address;
  /** Optional override for the round timing. */
  timing?: RoundTimingConfig;
  /** Optional minimum reserve price (wei of bidding token). Default 1. */
  minReservePrice?: bigint;
}

export interface DeployedContracts {
  biddingToken: Address;
  proxyAdmin: Address;
  auctionImpl: Address;
  auctionProxy: Address; // ← this is the address you talk to
  deployTxs: Record<string, Hash>;
  timing: RoundTimingConfig;
  beneficiary: Address;
  auctioneer: Address;
  initialOffsetTimestamp: number;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function deployContracts(input: DeployContractsInput): Promise<DeployedContracts> {
  const timing = input.timing ?? DEFAULT_DEMO_TIMING;
  const minReservePrice = input.minReservePrice ?? 1n;
  const deployTxs: Record<string, Hash> = {};

  // 1. Bidding token --------------------------------------------------------
  const biddingToken = await deployBiddingToken(input, deployTxs);

  // 2. ExpressLaneAuction implementation ------------------------------------
  const auctionImpl = await deployContract(
    input,
    {
      artifact: expressLaneAuctionArtifact,
      args: [],
      txKey: 'auctionImpl',
    },
    deployTxs,
  );

  // 3. ProxyAdmin (deployer becomes its owner) ------------------------------
  const proxyAdmin = await deployContract(
    input,
    {
      artifact: proxyAdminArtifact,
      args: [input.deployer.address] as readonly unknown[], // initialOwner (OZ 5.x ctor)
      txKey: 'proxyAdmin',
    },
    deployTxs,
  );

  // 4. Build initialize calldata ----------------------------------------------
  // The auction's `initialize` takes one tuple argument (InitArgs).
  // Mirrors nitro-testnode/scripts/ethcommands.ts:505-524 exactly.
  const offsetTimestamp = roundOffsetForRoundDuration(timing.roundDurationSeconds);
  const initData = encodeInitializeCalldata({
    auctioneer: input.auctioneer,
    biddingToken,
    beneficiary: input.beneficiary,
    timing,
    offsetTimestamp,
    minReservePrice,
    roleHolder: input.deployer.address, // dev convenience: deployer holds all setter roles
  });

  // 5. TransparentUpgradeableProxy(impl, admin, data) -----------------------
  const auctionProxy = await deployContract(
    input,
    {
      artifact: transparentProxyArtifact,
      args: [auctionImpl, proxyAdmin, initData] as readonly unknown[],
      txKey: 'auctionProxy',
    },
    deployTxs,
  );

  return {
    biddingToken,
    proxyAdmin,
    auctionImpl,
    auctionProxy,
    deployTxs,
    timing,
    beneficiary: input.beneficiary,
    auctioneer: input.auctioneer,
    initialOffsetTimestamp: offsetTimestamp,
  };
}

// ---------------------------------------------------------------------------
// Bidding token (mint to deployer so it can fund bidders later)
// ---------------------------------------------------------------------------

async function deployBiddingToken(input: DeployContractsInput, deployTxs: Record<string, Hash>): Promise<Address> {
  const compiled = compileMintableERC20();
  const data = encodeDeployData({
    abi: compiled.abi as never,
    bytecode: compiled.bytecode,
    args: ['Timeboost Bid Token', 'TBT'] as never,
  });
  return sendDeploy(input, data, 'biddingToken', deployTxs);
}

// ---------------------------------------------------------------------------
// Generic deploy helpers
// ---------------------------------------------------------------------------

interface DeployStepInput {
  artifact: { abi: import('viem').Abi; bytecode: Hex };
  args: readonly unknown[];
  txKey: string;
}

async function deployContract(
  input: DeployContractsInput,
  step: DeployStepInput,
  deployTxs: Record<string, Hash>,
): Promise<Address> {
  const data = encodeDeployData({
    abi: step.artifact.abi as never,
    bytecode: step.artifact.bytecode,
    args: step.args as never,
  });
  return sendDeploy(input, data, step.txKey, deployTxs);
}

async function sendDeploy(
  input: DeployContractsInput,
  data: Hex,
  txKey: string,
  deployTxs: Record<string, Hash>,
): Promise<Address> {
  const { publicClient, deployer } = input;
  const nonce = await publicClient.getTransactionCount({
    address: deployer.address,
    blockTag: 'pending',
  });
  const gasPrice = await publicClient.getGasPrice();
  const chainId = await publicClient.getChainId();

  const signed = (await deployer.signTransaction({
    chainId,
    type: 'eip1559',
    nonce,
    to: null,
    value: 0n,
    data,
    // Conservative gas: the ExpressLaneAuction implementation is sizeable.
    gas: 6_000_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
  })) as Hex;

  const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`Deploy ${txKey} failed: status=${receipt.status} txHash=${txHash}`);
  }

  deployTxs[txKey] = txHash;
  return receipt.contractAddress;
}

// ---------------------------------------------------------------------------
// initialize(InitArgs) calldata
// ---------------------------------------------------------------------------

interface EncodeInitArgs {
  auctioneer: Address;
  biddingToken: Address;
  beneficiary: Address;
  timing: RoundTimingConfig;
  offsetTimestamp: number;
  minReservePrice: bigint;
  roleHolder: Address;
}

/**
 * The auction's `initialize(InitArgs)` is documented in
 * `nitro-contracts/src/express-lane-auction/IExpressLaneAuction.sol`. The
 * struct ordering must match that file exactly. We hard-encode the tuple
 * because the artifact's auto-generated ABI describes the function input as
 * a single tuple and viem can encode it cleanly.
 */
function encodeInitializeCalldata(args: EncodeInitArgs): Hex {
  // viem's encodeFunctionData has a complicated generic; loosen to the
  // unconditional shape so we don't fight the inferred narrow `args` type.
  // The struct order MUST match IExpressLaneAuction.InitArgs (field order
  // is significant for ABI encoding).
  return (encodeFunctionData as unknown as (a: unknown) => Hex)({
    abi: expressLaneAuctionArtifact.abi,
    functionName: 'initialize',
    args: [
      {
        _auctioneer: args.auctioneer,
        _biddingToken: args.biddingToken,
        _beneficiary: args.beneficiary,
        _roundTimingInfo: {
          offsetTimestamp: BigInt(args.offsetTimestamp),
          roundDurationSeconds: BigInt(args.timing.roundDurationSeconds),
          auctionClosingSeconds: BigInt(args.timing.auctionClosingSeconds),
          reserveSubmissionSeconds: BigInt(args.timing.reserveSubmissionSeconds),
        },
        _minReservePrice: args.minReservePrice,
        _auctioneerAdmin: args.roleHolder,
        _minReservePriceSetter: args.roleHolder,
        _reservePriceSetter: args.roleHolder,
        _reservePriceSetterAdmin: args.roleHolder,
        _beneficiarySetter: args.roleHolder,
        _roundTimingSetter: args.roleHolder,
        _masterAdmin: args.roleHolder,
      },
    ],
  });
}

/**
 * Pick an offset timestamp that aligns to a round boundary near "now".
 * Mirrors testnode's `Math.round(Date.now() / 60000) * 60` but parameterised
 * by the round duration we picked (so 20s rounds align to 20s boundaries, etc.).
 */
function roundOffsetForRoundDuration(roundDurationSeconds: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / roundDurationSeconds) * roundDurationSeconds;
}

// ---------------------------------------------------------------------------
// Convenience: compute current round client-side from the deployed config.
// Mirrors nitro/timeboost/roundtiminginfo.go.
// ---------------------------------------------------------------------------

export function currentRoundFor(
  deployed: Pick<DeployedContracts, 'initialOffsetTimestamp' | 'timing'>,
  nowSec?: number,
): number {
  const t = nowSec ?? Math.floor(Date.now() / 1000);
  return Math.floor((t - deployed.initialOffsetTimestamp) / deployed.timing.roundDurationSeconds);
}

export function roundStartTimestamp(
  deployed: Pick<DeployedContracts, 'initialOffsetTimestamp' | 'timing'>,
  round: number,
): number {
  return deployed.initialOffsetTimestamp + round * deployed.timing.roundDurationSeconds;
}

/** Suppress unused-import warning (we may need encodeAbiParameters in tests later). */
void encodeAbiParameters;
