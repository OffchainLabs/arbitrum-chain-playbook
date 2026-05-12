/**
 * Phase 8 — full Timeboost lifecycle demo.
 *
 * Orchestrates Phases 2 → 7 in sequence:
 *   1. (Pre)  expects a deployed Orbit chain w/ a running MAIN sequencer
 *   2. Deploy ExpressLaneAuction stack on the child chain
 *   3. Start Redis + bid-validator + auctioneer services
 *   4. Patch sequencer config + restart with --add-host
 *   5. Generate Alice / Bob / Carol / Dave / Eve accounts; fund them
 *   6. Run 2-3 auction rounds; Bob wins, Carol becomes controller
 *   7. For each winning round: race express-lane vs normal txs (Phase 6)
 *   8. Negative demo: Eve tries to send express tx (NOT_EXPRESS_LANE_CONTROLLER)
 *   9. (Optional) one no-bid round
 *  10. Generate the HTML report (Phase 7)
 */

import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { inboxAbi } from '../malicious-validator/abis.js';
import path from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import logger from '../../utils/logger.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../../state/sendersEnv/index.js';
import { NodeType } from '../../types/index.js';
import { DOCKER_IMAGE, NODE_CONFIG_FILENAME } from '../../types/constants.js';
import { type OperationContext } from '../../utils/cancellation.js';
import { StepTracker } from '../../utils/ui.js';

import { deployChain } from '../../core/deployChain/deployChain.js';
import { getParentChain } from '../../utils/parentChain.js';
import { deployContracts, currentRoundFor, type DeployedContracts } from './deployContracts.js';
import { startTimeboostServices, stopTimeboostServices, BID_VALIDATOR_HOST_PORT } from './serviceManager.js';
import {
  patchSequencerConfigForPreFlight,
  patchSequencerConfigForTimeboost,
  TIMEBOOST_EXTRA_DOCKER_ARGS,
} from './nodeConfigPatch.js';
import { startAuctionMonitor } from './auctionMonitor.js';
import { runOneAuction } from './auctionRunner.js';
import { snapshotRound, formatRoundLine, waitUntilRound } from './roundClock.js';
import { runExperimentPair } from './experimentRecorder.js';
import { runUnauthorizedAttempt } from './unauthorizedTxRunner.js';
import { generateReport } from './reportGenerator.js';
import { biddingTokenAbi } from './abis.js';
import type { AuctionEvent, ExperimentRecord, NoBidRoundRecord, UnauthorizedAttemptRecord } from './types.js';
import { encodeFunctionData, type Address, type Hex } from 'viem';

// ---------------------------------------------------------------------------
// Public entry — invoked from the menu (`index.ts`)
// ---------------------------------------------------------------------------

export interface TimeboostDemoResult {
  reportPath: string;
  reportSize: number;
  experiments: ExperimentRecord[];
  noBidRounds: NoBidRoundRecord[];
  unauthorized: UnauthorizedAttemptRecord[];
  events: AuctionEvent[];
  deployed: DeployedContracts;
}

export async function runFullTimeboostDemo(ctx?: OperationContext): Promise<TimeboostDemoResult> {
  const chainEnv = ChainEnv.getInstance();
  const sendersEnv = SendersEnv.getInstance();

  const tracker = new StepTracker([
    'Deploy fresh Orbit chain',
    'Bring up sequencer',
    'Top up deployer balance on L2',
    'Deploy ExpressLaneAuction stack',
    'Generate + fund demo accounts',
    'Start Timeboost services',
    'Patch sequencer config + restart',
    'Run 3 auction rounds',
    'Express-lane vs normal experiments',
    'Negative demo (NOT_EXPRESS_LANE_CONTROLLER)',
    'No-bid round (control)',
    'Generate HTML report',
  ]);
  ctx?.onCleanup(async () => tracker.fail('Cancelled'));

  // -------------------------------------------------------------------------
  // 0. Chain deploy — this command is declared `redeploysChain: true`, so
  //    always tear down leftover state and deploy a fresh chain. Reusing a
  //    persisted node-config.json is intentionally not supported: load()
  //    drops coreContracts (so the L1->L2 top-up below would fail with
  //    "inbox address not available"), and a stale
  //    `execution.sequencer.timeboost` block from a previous run would
  //    point the first sequencer start at an expired auction contract.
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Deploy fresh Orbit chain');
  tracker.start();

  if (chainEnv.nodeManager) {
    const running = chainEnv.nodeManager.getRunningNodes();
    if (running.length > 0) {
      logger.info(`stopping ${running.length} leftover node(s)...`);
      await chainEnv.nodeManager.stopAllNodes();
    }
  }
  if (chainEnv.status.isInitiated()) {
    chainEnv.reset();
  }

  const parentChain = getParentChain();
  const ok = await deployChain(parentChain, ctx, { skipPrompts: true });
  if (!ok) throw new Error('Chain deployment failed (check parent chain RPC + funded MAIN_PRIVATE_KEY).');
  if (!chainEnv.status.isInitiated()) {
    if (!chainEnv.load()) throw new Error('Chain deploy succeeded but ChainEnv could not be loaded.');
  }
  logger.success('Fresh chain deployed.');
  ctx?.stepCompleted('Deploy fresh Orbit chain');

  const chainId = chainEnv.chainConfig.getChainId();
  if (!chainId) throw new Error('Chain ID not available after deploy.');
  const nodeManager = chainEnv.nodeManager;
  if (!nodeManager) throw new Error('NodeManager unavailable after deploy.');

  // -------------------------------------------------------------------------
  // 1. Sequencer (must be MAIN node, no Timeboost yet — config patched later).
  //    Apply pre-flight skip-validation patch first so the sequencer doesn't
  //    crash on a wasmModuleRoot mismatch (we don't need staking correctness).
  //    Also wipe any stale local DB for this chainId; otherwise the sequencer
  //    crashes with "Delayed sequencer error: wrong msgIdx got X expected Y"
  //    when on-chain state has moved past what the DB recorded.
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Bring up sequencer');
  tracker.start();
  patchSequencerConfigForPreFlight();
  // Always-fresh deploy: no sequencer can be alive for this new chainId, so
  // unconditionally wipe any leftover local DB at this path.
  wipeLocalChainData(chainId);
  logger.info('node-config patched: block-validator off, bold strategy cleared, track-block-metadata-from=1');
  const main = await ensureMainNode(nodeManager);
  const sequencerHttpUrl = `http://localhost:${main.config.httpPort}`;
  await waitForChildRpcReady(sequencerHttpUrl);
  ctx?.stepCompleted('Bring up sequencer');

  // -------------------------------------------------------------------------
  // 1.5 Top up deployer's L2 balance.
  //   The chain-deploy step bridges only ~0.001 ETH which is way below what we
  //   need for 4 contract deploys + funding 5 demo accounts + auctioneer hot
  //   wallet. Bridge a generous chunk via inbox.depositEth() and wait for it.
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Top up deployer balance on L2');
  tracker.start();

  const childChain = defineChain({
    id: chainId,
    name: 'Orbit',
    network: 'orbit',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [sequencerHttpUrl] }, public: { http: [sequencerHttpUrl] } },
  });
  const childPublic = createPublicClient({ chain: childChain, transport: http(sequencerHttpUrl) });

  const deployerSender = firstRegular(sendersEnv);
  const deployer = privateKeyToAccount(deployerSender.privateKey);
  const deployerWallet = createWalletClient({
    account: deployer,
    chain: childChain,
    transport: http(sequencerHttpUrl),
  });

  await topUpDeployerOnL2({ chainEnv, deployer, childPublic });
  ctx?.stepCompleted('Top up deployer balance on L2');

  // -------------------------------------------------------------------------
  // 2. Deploy contracts
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Deploy ExpressLaneAuction stack');
  tracker.start();

  const auctioneerKey = generatePrivateKey();
  const auctioneer = privateKeyToAccount(auctioneerKey);

  const deployed = await deployContracts({
    deployer,
    publicClient: childPublic,
    walletClient: deployerWallet,
    auctioneer: auctioneer.address,
    beneficiary: deployer.address, // demo: send proceeds back to deployer
  });
  logger.success(`auction proxy: ${deployed.auctionProxy}`);
  logger.success(`bidding token: ${deployed.biddingToken}`);

  ctx?.stepCompleted('Deploy ExpressLaneAuction stack');

  // -------------------------------------------------------------------------
  // 3. Generate + fund Alice / Bob / Carol / Dave / Eve
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Generate + fund demo accounts');
  tracker.start();

  const accounts = await generateAndFundDemoAccounts({
    publicClient: childPublic,
    deployer,
    biddingToken: deployed.biddingToken,
    auctioneerToFund: auctioneer.address,
  });

  ctx?.stepCompleted('Generate + fund demo accounts');

  // -------------------------------------------------------------------------
  // 4. Start auctioneer + bid-validator + Redis
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Start Timeboost services');
  tracker.start();

  await startTimeboostServices({
    auctioneerImage: DOCKER_IMAGE,
    auctionContractAddress: deployed.auctionProxy,
    auctioneerAddress: auctioneer.address,
    childChainRpcEndpoint: 'http://host.docker.internal:' + main.config.httpPort,
    sequencerRpcEndpoint: 'http://host.docker.internal:' + main.config.httpPort,
    auctioneerPrivateKey: auctioneerKey,
  });
  const bidValidatorUrl = `http://localhost:${BID_VALIDATOR_HOST_PORT}`;
  ctx?.onCleanup(async () => stopTimeboostServices());
  ctx?.stepCompleted('Start Timeboost services');

  // -------------------------------------------------------------------------
  // 5. Patch sequencer config + restart MAIN with --add-host
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Patch sequencer config + restart');
  tracker.start();

  patchSequencerConfigForTimeboost(
    {
      auctionContractAddress: deployed.auctionProxy,
      auctioneerAddress: auctioneer.address,
      redisUrl: 'redis://host.docker.internal:6379',
    },
    path.join(process.cwd(), NODE_CONFIG_FILENAME),
  );

  await nodeManager.stopNode(main.config.id);
  const restarted = await nodeManager.startNode(NodeType.MAIN, {
    extraDockerArgs: TIMEBOOST_EXTRA_DOCKER_ARGS,
  });
  if (!restarted) throw new Error('Failed to restart sequencer with Timeboost config.');
  await waitForChildRpcReady(`http://localhost:${restarted.config.httpPort}`);
  ctx?.stepCompleted('Patch sequencer config + restart');

  // -------------------------------------------------------------------------
  // 6. Auctions x3 — Bob wins all, Carol becomes controller
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Run 3 auction rounds');
  tracker.start();

  const restartedClient = createPublicClient({
    chain: childChain,
    transport: http(`http://localhost:${restarted.config.httpPort}`),
  });

  const monitor = startAuctionMonitor(restartedClient, deployed.auctionProxy);
  ctx?.onCleanup(async () => monitor.stop());

  const timing = {
    offsetTimestamp: deployed.initialOffsetTimestamp,
    roundDurationSeconds: deployed.timing.roundDurationSeconds,
    auctionClosingSeconds: deployed.timing.auctionClosingSeconds,
    reserveSubmissionSeconds: deployed.timing.reserveSubmissionSeconds,
  };
  logger.info(formatRoundLine(snapshotRound(timing)));

  const auctionResults = [] as Awaited<ReturnType<typeof runOneAuction>>[];
  for (let i = 0; i < 3; i++) {
    const result = await runOneAuction(
      {
        publicClient: restartedClient,
        auctionAddress: deployed.auctionProxy,
        biddingTokenAddress: deployed.biddingToken,
        bidValidatorUrl,
        timing,
        aliceKey: accounts.alice.privateKey,
        bobKey: accounts.bob.privateKey,
        controller: accounts.carol.account.address,
        aliceBidAmount: parseUnits('100', 0),
        bobBidAmount: parseUnits('250', 0),
        aliceNeedsDeposit: i === 0,
        bobNeedsDeposit: i === 0,
        depositAmount: parseUnits('5000', 0),
      },
      monitor.events,
    );
    auctionResults.push(result);
  }
  ctx?.stepCompleted('Run 3 auction rounds');

  // -------------------------------------------------------------------------
  // 7. Express-lane vs normal experiments (5 pairs spread over winning rounds)
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Express-lane vs normal experiments');
  tracker.start();

  const experiments: ExperimentRecord[] = [];
  // Use the LATEST won round (controller=Carol) for all experiment pairs.
  const lastResolvedRound = auctionResults[auctionResults.length - 1].bidForRound;
  await waitUntilRound(timing, lastResolvedRound);
  await sleep(500);

  for (let i = 0; i < 5; i++) {
    const exp = await runExperimentPair({
      index: i,
      round: lastResolvedRound,
      controller: accounts.carol.account.address,
      childClient: restartedClient,
      expressLaneSubmit: {
        controllerAccount: accounts.carol.account,
        childClient: restartedClient,
        chainId,
        round: BigInt(lastResolvedRound),
        auctionContractAddress: deployed.auctionProxy,
        sequencerRpcUrl: `http://localhost:${restarted.config.httpPort}`,
        to: accounts.dave.account.address,
      },
      normalTx: {
        senderAccount: accounts.dave.account,
        childClient: restartedClient,
        chainId,
        to: accounts.alice.account.address,
      },
    });
    experiments.push(exp);
    await sleep(750);
  }
  ctx?.stepCompleted('Express-lane vs normal experiments');

  // -------------------------------------------------------------------------
  // 8. Negative demo
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Negative demo (NOT_EXPRESS_LANE_CONTROLLER)');
  tracker.start();

  const unauthorized: UnauthorizedAttemptRecord[] = [];
  unauthorized.push(
    await runUnauthorizedAttempt({
      unauthorizedAccount: accounts.eve.account,
      childClient: restartedClient,
      chainId,
      round: BigInt(snapshotRound(timing).current),
      auctionContractAddress: deployed.auctionProxy,
      sequencerRpcUrl: `http://localhost:${restarted.config.httpPort}`,
      to: accounts.alice.account.address,
    }),
  );
  ctx?.stepCompleted('Negative demo (NOT_EXPRESS_LANE_CONTROLLER)');

  // -------------------------------------------------------------------------
  // 9. No-bid round
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('No-bid round (control)');
  tracker.start();

  const noBidRound = snapshotRound(timing).current + 1;
  await waitUntilRound(timing, noBidRound);
  await sleep(500);
  const noBidObs = [] as NoBidRoundRecord['observations'];
  // Just send one normal tx (no controller exists this round, so EL would be rejected).
  const nonce = await restartedClient.getTransactionCount({
    address: accounts.dave.account.address,
    blockTag: 'pending',
  });
  const gasPrice = await restartedClient.getGasPrice();
  const signed = (await accounts.dave.account.signTransaction({
    chainId,
    type: 'eip1559',
    to: accounts.alice.account.address,
    value: 0n,
    data: '0x',
    gas: 100_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
  })) as Hex;
  const sentAtMs = Date.now();
  const txHash = await restartedClient.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await restartedClient.waitForTransactionReceipt({ hash: txHash, pollingInterval: 50 });
  const receiptAtMs = Date.now();
  const block = await restartedClient.getBlock({ blockNumber: receipt.blockNumber });
  const rawReceipt = (await restartedClient.transport.request({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  })) as Record<string, unknown> | null;
  noBidObs.push({
    lane: 'normal',
    sentAtMs,
    receiptAtMs,
    txHash,
    blockNumber: receipt.blockNumber,
    blockTimestampSec: block.timestamp,
    txIndex: receipt.transactionIndex,
    timeboosted: typeof rawReceipt?.timeboosted === 'boolean' ? rawReceipt.timeboosted : null,
    sender: accounts.dave.account.address,
    round: noBidRound,
  });

  const noBidRounds: NoBidRoundRecord[] = [{ round: noBidRound, startedAtMs: Date.now(), observations: noBidObs }];
  ctx?.stepCompleted('No-bid round (control)');

  // -------------------------------------------------------------------------
  // 10. Render HTML report
  // -------------------------------------------------------------------------
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Generate HTML report');
  tracker.start();

  monitor.stop();
  const events = monitor.events.slice();
  const reportRes = generateReport({
    chainId: Number(chainId),
    auctionContract: deployed.auctionProxy,
    biddingToken: deployed.biddingToken,
    roundDurationSeconds: deployed.timing.roundDurationSeconds,
    auctionClosingSeconds: deployed.timing.auctionClosingSeconds,
    reserveSubmissionSeconds: deployed.timing.reserveSubmissionSeconds,
    nonExpressDelayMsec: 200,
    experiments,
    noBidRounds,
    unauthorized,
    events,
  });
  logger.success(`Report: ${reportRes.filePath} (${(reportRes.byteSize / 1024).toFixed(1)} KB)`);

  ctx?.stepCompleted('Generate HTML report');
  tracker.complete('Timeboost demo complete');

  return {
    reportPath: reportRes.filePath,
    reportSize: reportRes.byteSize,
    experiments,
    noBidRounds,
    unauthorized,
    events,
    deployed,
  };
}

// ---------------------------------------------------------------------------
// Status / stop helpers (called by the menu)
// ---------------------------------------------------------------------------

export async function viewTimeboostStatus(): Promise<void> {
  // For now: a thin status line. Phase 8 polish can pull current round + controller
  // from the deployed contract once we persist its address. Until then we just
  // delegate to docker for service status.
  logger.section('Timeboost services');
  try {
    // Lazy-load `dockerCommand` to avoid pulling docker-cli-js on import-time.
    const { dockerCommand } = await import('docker-cli-js');
    const r = await dockerCommand('ps --filter name=timeboost- --format "{{.Names}} {{.Status}}"', {
      echo: false,
    });
    logger.raw(((r as { raw?: string })?.raw ?? '<no timeboost services running>').trim());
  } catch (e) {
    logger.warn(`docker query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function stopTimeboostStack(): Promise<void> {
  await stopTimeboostServices();
  logger.success('Timeboost services stopped.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DemoActor {
  account: ReturnType<typeof privateKeyToAccount>;
  privateKey: `0x${string}`;
}

interface DemoAccounts {
  alice: DemoActor;
  bob: DemoActor;
  carol: DemoActor;
  dave: DemoActor;
  eve: DemoActor;
}

function makeActor(): DemoActor {
  const privateKey = generatePrivateKey();
  return { privateKey, account: privateKeyToAccount(privateKey) };
}

interface FundInput {
  publicClient: ReturnType<typeof createPublicClient>;
  deployer: ReturnType<typeof privateKeyToAccount>;
  biddingToken: Address;
  auctioneerToFund: Address;
}

async function generateAndFundDemoAccounts(input: FundInput): Promise<DemoAccounts> {
  const accounts: DemoAccounts = {
    alice: makeActor(),
    bob: makeActor(),
    carol: makeActor(),
    dave: makeActor(),
    eve: makeActor(),
  };

  // Fund each demo account with native ETH for gas.
  const ethEach = parseEther('0.05');
  for (const [name, actor] of Object.entries(accounts) as [keyof DemoAccounts, DemoActor][]) {
    await sendNativeEth(input.publicClient, input.deployer, actor.account.address, ethEach);
    logger.info(`funded ${name} (${actor.account.address}) with ${formatEther(ethEach)} ETH`);
  }
  // Auctioneer hot wallet needs ETH to send resolve* txs.
  await sendNativeEth(input.publicClient, input.deployer, input.auctioneerToFund, parseEther('0.1'));

  // Mint bidding tokens to Alice & Bob.
  const tokenAmount = 1_000_000n;
  for (const actor of [accounts.alice, accounts.bob]) {
    const data = encodeFunctionData({
      abi: biddingTokenAbi,
      functionName: 'mint',
      args: [actor.account.address, tokenAmount],
    });
    await sendCall(input.publicClient, input.deployer, input.biddingToken, data);
  }

  return accounts;
}

async function sendNativeEth(
  pub: ReturnType<typeof createPublicClient>,
  signer: ReturnType<typeof privateKeyToAccount>,
  to: Address,
  value: bigint,
): Promise<void> {
  const nonce = await pub.getTransactionCount({ address: signer.address, blockTag: 'pending' });
  const gasPrice = await pub.getGasPrice();
  const chainId = await pub.getChainId();
  const signed = (await signer.signTransaction({
    chainId,
    type: 'eip1559',
    to,
    value,
    data: '0x',
    gas: 100_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
  })) as Hex;
  const txHash = await pub.sendRawTransaction({ serializedTransaction: signed });
  await pub.waitForTransactionReceipt({ hash: txHash });
}

async function sendCall(
  pub: ReturnType<typeof createPublicClient>,
  signer: ReturnType<typeof privateKeyToAccount>,
  to: Address,
  data: Hex,
): Promise<void> {
  const nonce = await pub.getTransactionCount({ address: signer.address, blockTag: 'pending' });
  const gasPrice = await pub.getGasPrice();
  const chainId = await pub.getChainId();
  const signed = (await signer.signTransaction({
    chainId,
    type: 'eip1559',
    to,
    value: 0n,
    data,
    gas: 300_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
  })) as Hex;
  const txHash = await pub.sendRawTransaction({ serializedTransaction: signed });
  await pub.waitForTransactionReceipt({ hash: txHash });
}

async function ensureMainNode(
  nodeManager: NonNullable<ChainEnv['nodeManager']>,
): Promise<NonNullable<Awaited<ReturnType<NonNullable<ChainEnv['nodeManager']>['startNode']>>>> {
  const running = nodeManager.getRunningNodes().find((n) => n.config.nodeType === NodeType.MAIN);
  if (running) return running;
  const started = await nodeManager.startNode(NodeType.MAIN);
  if (!started) throw new Error('Failed to start MAIN sequencer node.');
  await sleep(8000);
  return started;
}

/**
 * Poll a sequencer's HTTP RPC until it responds successfully (or timeout).
 * After `docker run -d`, the container may need 30-90s before HTTP is
 * reliably responsive — it has to process delayed messages, set up the
 * staker, etc. The previous "sleep 8s" was insufficient on real Sepolia.
 */
async function waitForChildRpcReady(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string; error?: { message: string } };
        if (body.result) {
          logger.info(`child RPC ready at ${url} (chainId ${parseInt(body.result, 16)})`);
          return;
        }
        lastErr = body.error?.message ?? 'unknown';
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }
  throw new Error(`child RPC ${url} not ready after ${timeoutMs}ms (last: ${lastErr})`);
}

/**
 * Wipe `.arbitrum/<chainId>/` so the sequencer rebuilds from genesis off the
 * inbox. Guards against "wrong msgIdx" errors caused by leftover DB state
 * from prior crashed runs.
 */
function wipeLocalChainData(chainId: number | bigint): void {
  const dir = path.join(process.cwd(), '.arbitrum', String(chainId));
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    logger.info(`wiped local chain data at ${dir}`);
  }
}

/**
 * Bridge ~0.5 ETH from L1 → L2 deployer if its L2 balance is below 0.5 ETH.
 * Required because deployChain bridges only ~0.001 ETH which is way too little
 * for 4 contract deploys + 5 demo account fundings + auctioneer hot wallet.
 */
async function topUpDeployerOnL2(args: {
  chainEnv: ChainEnv;
  deployer: ReturnType<typeof privateKeyToAccount>;
  childPublic: ReturnType<typeof createPublicClient>;
}): Promise<void> {
  const TARGET = parseEther('0.5');
  const balance = await args.childPublic.getBalance({ address: args.deployer.address });
  logger.info(`L2 deployer balance: ${formatEther(balance)} ETH`);
  if (balance >= TARGET) {
    logger.info('Already above target; skipping deposit.');
    return;
  }

  const need = TARGET - balance + parseEther('0.05'); // little buffer
  const coreContracts = args.chainEnv.chainConfig.getCoreContracts();
  const inbox = coreContracts?.inbox as `0x${string}` | undefined;
  if (!inbox) throw new Error('inbox address not available from ChainEnv');
  const parentClient = args.chainEnv.parentChainClient;
  if (!parentClient) throw new Error('parent chain client not available');

  const parentWallet = createWalletClient({
    account: args.deployer,
    chain: parentClient.chain,
    transport: http(parentClient.transport.url),
  });

  logger.info(`Bridging ${formatEther(need)} ETH from L1 → L2 (deposit via inbox)...`);
  const txHash = await (
    parentWallet as unknown as { writeContract: (a: unknown) => Promise<`0x${string}`> }
  ).writeContract({
    address: inbox,
    abi: inboxAbi,
    functionName: 'depositEth',
    value: need,
    chain: parentClient.chain,
    account: args.deployer,
  });
  await parentClient.waitForTransactionReceipt({ hash: txHash });
  logger.info(`L1 deposit confirmed: ${txHash}`);

  // Wait for funds to surface on L2 (typically 60-120s on Sepolia).
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const b = await args.childPublic.getBalance({ address: args.deployer.address });
    if (b >= TARGET) {
      logger.success(`L2 deployer balance now ${formatEther(b)} ETH`);
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('Timed out waiting for L1 → L2 deposit to surface (4 min).');
}

function firstRegular(sendersEnv: SendersEnv): { privateKey: `0x${string}` } {
  const senders = sendersEnv.getAllByRole(SenderRole.RegularSender);
  if (senders.length === 0) throw new Error('No RegularSender account in SendersEnv.');
  return senders[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
