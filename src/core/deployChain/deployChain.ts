import inquirer from 'inquirer';
import { generatePrivateKey } from 'viem/accounts';
import { generateChainId } from '@arbitrum/chain-sdk/utils';
import logger from '../../utils/logger.js';
import { StepTracker } from '../../utils/ui.js';
import type { OperationContext } from '../../utils/cancellation.js';
import { Chain, createWalletClient, formatEther, http, parseEther, PrivateKeyAccount, PublicClient } from 'viem';
import {
  createRollup,
  createRollupPrepareDeploymentParamsConfig,
  CreateRollupResults,
  prepareChainConfig,
  CoreContracts,
} from '@arbitrum/chain-sdk';
import {
  generateNodeConfiguration,
  overwriteToNodeConfigForMainNode,
  overwriteToNodeConfigForHonestValidator,
} from '../../utils/nodeConfigUtils.js';
import { writeFile } from 'fs/promises';
import { NodeType } from '../../types/index.js';
import {
  BASE_STAKE_ETH,
  TEST_TOKENS_AMOUNT_ETH,
  VALIDATOR_AMOUNT_ETH,
  CONFIRM_PERIOD_BLOCKS,
  MINIMUM_ASSERTION_PERIOD,
  L2_DEPOSIT_AMOUNT_ETH,
} from '../../types/constants.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { ChainStatus } from '../../state/chainEnv/types.js';
import { saveNodeConfigForType } from '../../state/chainEnv/persistence.js';
import { SendersEnv, SenderRole } from '../../state/sendersEnv/index.js';
import { depositEthToInbox } from '../interactChain/depositToL2.js';

const BASE_STAKE = parseEther(BASE_STAKE_ETH);
const TEST_TOKENS_AMOUNT = parseEther(TEST_TOKENS_AMOUNT_ETH);
const VALIDATOR_AMOUNT = parseEther(VALIDATOR_AMOUNT_ETH);
// gas needs: 2 validators (for challenge) + 1 batch poster + deployer
const TOKEN_NEEDS_FOR_DEPLOY = BASE_STAKE + VALIDATOR_AMOUNT * 2n + TEST_TOKENS_AMOUNT;

const sendTestTokens = async (
  sender: PrivateKeyAccount,
  toAddress: string,
  parentChainPublicClient: PublicClient,
  amount: bigint = TEST_TOKENS_AMOUNT,
): Promise<`0x${string}` | null> => {
  const existing = await parentChainPublicClient.getBalance({ address: toAddress as `0x${string}` });
  if (existing >= amount) {
    logger.info(
      `Skipping fund transfer to ${toAddress}: balance ${formatEther(existing)} ETH >= ${formatEther(amount)} ETH`,
    );
    return null;
  }

  const walletClient = createWalletClient({
    account: sender,
    chain: parentChainPublicClient.chain,
    transport: http(process.env.PARENT_CHAIN_RPC),
  });
  const tx = await walletClient.sendTransaction({
    to: toAddress as `0x${string}`,
    value: amount,
    chain: parentChainPublicClient.chain,
  });
  logger.txHash(tx, 'sendTransaction');
  return tx;
};

// Deploy the rollup contracts, we need one batch poster and two validators for this playbook
const deployRollupContracts = async (
  deployer: PrivateKeyAccount,
  validatorAddresses: `0x${string}`[],
  batchPosterAddress: `0x${string}`,
  parentChainPublicClient: PublicClient,
  chainId: number,
  confirmPeriodBlocksOverride?: bigint,
): Promise<CreateRollupResults> => {
  const createRollupConfig = createRollupPrepareDeploymentParamsConfig(parentChainPublicClient, {
    chainId: BigInt(chainId),
    owner: deployer.address,
    baseStake: BASE_STAKE,
    confirmPeriodBlocks: confirmPeriodBlocksOverride ?? CONFIRM_PERIOD_BLOCKS,
    minimumAssertionPeriod: MINIMUM_ASSERTION_PERIOD,
    wasmModuleRoot: '0xc2c02df561d4afaf9a1d6785f70098ec3874765c638e3cb6dbe8d3c83333e14c',
    // To make sure the fraud proof finishes very quickly (Just for fun, can't be used in production)
    layerZeroBlockEdgeHeight: BigInt(2 ** 7),
    layerZeroBigStepEdgeHeight: BigInt(2 ** 16),
    layerZeroSmallStepEdgeHeight: BigInt(2 ** 16),
    chainConfig: prepareChainConfig({
      chainId,
      arbitrum: {
        InitialChainOwner: deployer.address,
        DataAvailabilityCommittee: false,
      },
    }),
  });

  try {
    return await createRollup({
      params: {
        config: createRollupConfig,
        batchPosters: [batchPosterAddress],
        validators: validatorAddresses,
      },
      account: deployer,
      parentChainPublicClient,
    });
  } catch (error) {
    console.error(`Rollup creation failed with error: ${error}`);
    throw error;
  }
};

/**
 * Overrides for chain deployment parameters
 */
export interface DeployChainOverrides {
  confirmPeriodBlocks?: bigint;
  /** Skip interactive prompts (auto-generate chain ID, auto-confirm) */
  skipPrompts?: boolean;
}

/**
 * Deploy a new blockchain
 * Updates ChainEnv singleton with deployment result
 * @returns true if deployment was successful
 */
export async function deployChain(
  parentChain: Chain,
  ctx?: OperationContext,
  overrides?: DeployChainOverrides,
): Promise<boolean> {
  const chainEnv = ChainEnv.getInstance();
  const sendersEnv = SendersEnv.getInstance();

  logger.section('Deploy New Chain');

  logger.info('Pre-checking before chain deployment...');

  // Get deployer from SendersEnv (first RegularSender account)
  const deployers = sendersEnv.getAllByRole(SenderRole.RegularSender);
  if (deployers.length === 0) {
    logger.errorWithFix(
      'Deployer account not found.',
      'Set MAIN_PRIVATE_KEY in your .env file with a funded account private key.',
    );
    return false;
  }
  const deployer = deployers[0].signer;

  // Get parent chain public client from ChainEnv
  const parentChainPublicClient = chainEnv.parentChainClient;
  if (!parentChainPublicClient) {
    logger.errorWithFix(
      'Parent chain public client not configured.',
      'Set PARENT_CHAIN_RPC in your .env file (e.g. PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc).',
    );
    return false;
  }

  const balance = await parentChainPublicClient.getBalance({ address: deployer.address });
  if (balance < TOKEN_NEEDS_FOR_DEPLOY) {
    logger.errorWithFix(
      `Insufficient balance. Current: ${formatEther(balance)} ETH, Required: ~${formatEther(TOKEN_NEEDS_FOR_DEPLOY)} ETH.`,
      `Fund the deployer account (${deployer.address}) via https://www.alchemy.com/faucets/arbitrum-sepolia`,
    );
    return false;
  }

  const randomChainId = generateChainId();

  let chainId: number;
  if (overrides?.skipPrompts) {
    chainId = randomChainId;
    logger.info(`Using auto-generated Chain ID: ${chainId}`);
  } else {
    const answers = await inquirer.prompt<{ chainId: number; confirm: boolean }>([
      {
        type: 'input',
        name: 'chainId',
        message: `Enter Chain ID (leave empty to use random chain id: ${randomChainId}):`,
        default: randomChainId,
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: (answers: { chainId: number }) => `Deploy chain with Chain ID: ${answers.chainId}?`,
        default: true,
      },
    ]);

    if (!answers.confirm) {
      logger.warn('Chain deployment cancelled.');
      return false;
    }

    chainId = answers.chainId;
  }

  logger.newline();
  logger.info('Starting chain deployment...');

  // Set status to deploying
  chainEnv.status.set(ChainStatus.DEPLOYING);

  const tracker = new StepTracker([
    'Generating validator keys',
    'Sending test tokens to validator accounts',
    'Deploying rollup contracts',
    'Generating node configuration',
    'Depositing ETH to inbox for L2 funding',
  ]);

  ctx?.onCleanup(async () => tracker.fail('Cancelled'));

  let deployRollupResult!: CreateRollupResults;
  let coreContracts!: CoreContracts;

  try {
    // Step 1: Generate the validator keys and the batch poster key
    ctx?.throwIfCancelled();
    ctx?.stepStarted('Generating validator keys');
    tracker.start();

    // Clear any previously accumulated Validator/BatchPoster accounts to avoid
    // funding stale keys from previous deployments in the same session.
    sendersEnv.clearByRole(SenderRole.Validator);
    sendersEnv.clearByRole(SenderRole.BatchPoster);

    // Validator[0] (main / malicious staker): use env key if provided, else random.
    const validator0Key = (process.env.VALIDATOR_PRIVATE_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
    sendersEnv.addByPrivateKey(validator0Key, SenderRole.Validator);

    // Validator[1] (honest validator staker): always randomly generated.
    sendersEnv.addByPrivateKey(generatePrivateKey(), SenderRole.Validator);

    // BatchPoster: use env key if provided, else random.
    const batchPosterKey = (process.env.BATCH_POSTER_PRIVATE_KEY as `0x${string}` | undefined) ?? generatePrivateKey();
    sendersEnv.addByPrivateKey(batchPosterKey, SenderRole.BatchPoster);

    ctx?.stepCompleted('Generating validator keys');

    // Step 2: Send tokens to validators and batch poster
    ctx?.throwIfCancelled();
    ctx?.stepStarted('Sending test tokens');
    tracker.start();
    const validators = sendersEnv.getAllByRole(SenderRole.Validator);
    const batchPosters = sendersEnv.getAllByRole(SenderRole.BatchPoster);
    for (const validator of validators) {
      await sendTestTokens(deployer, validator.signer.address, parentChainPublicClient, VALIDATOR_AMOUNT);
    }
    for (const account of batchPosters) {
      await sendTestTokens(deployer, account.signer.address, parentChainPublicClient);
    }

    ctx?.stepCompleted('Sending test tokens');

    // Step 3: Deploy the rollup contracts
    ctx?.throwIfCancelled();
    ctx?.stepStarted('Deploying rollup contracts');
    tracker.start();
    const validatorAddresses = sendersEnv.getAllByRole(SenderRole.Validator).map((a) => a.signer.address);
    const batchPosterAddress = sendersEnv.getAllByRole(SenderRole.BatchPoster)[0].signer.address;
    deployRollupResult = await deployRollupContracts(
      deployer,
      validatorAddresses,
      batchPosterAddress,
      parentChainPublicClient,
      chainId,
      overrides?.confirmPeriodBlocks,
    );
    coreContracts = deployRollupResult.coreContracts as CoreContracts;

    ctx?.stepCompleted('Deploying rollup contracts');

    // Step 4: Generate node configuration
    ctx?.throwIfCancelled();
    ctx?.stepStarted('Generating node configuration');
    tracker.start();
    const nodeAccounts = [
      ...sendersEnv.getAllByRole(SenderRole.Validator),
      ...sendersEnv.getAllByRole(SenderRole.BatchPoster),
    ];
    const configResult = await generateNodeConfiguration(
      deployRollupResult.transaction.hash,
      parentChain,
      parentChainPublicClient,
      nodeAccounts,
      process.env.PARENT_CHAIN_RPC,
    );

    // Configure main node with feed output enabled (for honest validator to subscribe)
    overwriteToNodeConfigForMainNode(configResult.nodeConfig);

    const mainConfigPath = configResult.nodeConfigPaths.get(NodeType.MAIN)!;
    await writeFile(mainConfigPath, JSON.stringify(configResult.nodeConfig, null, 2));

    // Generate honest validator config with second validator's private key
    const allValidators = sendersEnv.getAllByRole(SenderRole.Validator);
    if (allValidators.length >= 2) {
      const honestNodeConfig = JSON.parse(JSON.stringify(configResult.nodeConfig));

      if (honestNodeConfig.node?.staker?.['parent-chain-wallet']) {
        const rawPrivateKey = allValidators[1].privateKey.startsWith('0x')
          ? allValidators[1].privateKey.slice(2)
          : allValidators[1].privateKey;
        honestNodeConfig.node.staker['parent-chain-wallet']['private-key'] = rawPrivateKey;
      }

      const mainNodeHttpPort = configResult.nodeConfig.http?.port ?? 8449;
      overwriteToNodeConfigForHonestValidator(honestNodeConfig, mainNodeHttpPort);
      saveNodeConfigForType(NodeType.HONEST, honestNodeConfig);

      configResult.nodeConfigPaths.set(
        NodeType.HONEST,
        configResult.nodeConfigPaths.get(NodeType.MAIN)!.replace('node-config.json', 'node-config-honest.json'),
      );
    }

    // Set deployment result on ChainEnv
    chainEnv.setDeploymentResult(
      configResult.chainConfig,
      configResult.nodeConfig,
      coreContracts,
      configResult.nodeConfigPaths,
    );

    ctx?.stepCompleted('Generating node configuration');

    // Step 5: Deposit ETH to inbox for L2 funding
    ctx?.throwIfCancelled();
    ctx?.stepStarted('Depositing ETH to inbox');
    tracker.start();
    const contracts = deployRollupResult.coreContracts;
    await depositEthToInbox({
      account: deployer,
      parentChainPublicClient,
      parentRpcUrl: process.env.PARENT_CHAIN_RPC!,
      inboxAddress: contracts.inbox as `0x${string}`,
      amountEth: L2_DEPOSIT_AMOUNT_ETH,
    });

    ctx?.stepCompleted('Depositing ETH to inbox');
    tracker.complete('Chain deployed successfully!');
    logger.newline();
    logger.raw(`  Chain ID:       ${chainEnv.chainConfig.getChainId()}`);
    logger.newline();

    return true;
  } catch (error) {
    tracker.fail();
    chainEnv.status.set(ChainStatus.ERROR);
    logger.errorWithFix(
      `Deployment failed: ${error instanceof Error ? error.message : String(error)}`,
      'Check PARENT_CHAIN_RPC connectivity, deployer balance, and Docker status.',
    );
    return false;
  }
}

export default deployChain;
