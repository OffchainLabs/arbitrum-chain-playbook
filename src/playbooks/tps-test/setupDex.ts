import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  parseEther,
  parseUnits,
  type Abi,
  type Hex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { deployToken } from './deployToken.js';
import { deployUniswap } from './deployUniswap.js';
import { DexSetupConfig, DexSetupResult } from './types.js';

/**
 * Full DEX Setup (viem)
 *
 * 1. Deploys a test ERC20 token
 * 2. Deploys Uniswap V2 (WETH, Factory, Router)
 * 3. Creates a Token/WETH liquidity pool
 * 4. Adds initial liquidity for swapping
 */

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_DEX_CONFIG: DexSetupConfig = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  token: {
    name: 'Test Token',
    symbol: 'TEST',
    decimals: 18,
    initialSupply: '1000000000', // 1 billion tokens
  },
  liquidity: {
    ethAmount: '10', // 10 ETH
    tokenAmount: '100000000', // 100 million tokens
  },
};

// =============================================================================
// Setup DEX
// =============================================================================

export async function setupDex(config: Partial<DexSetupConfig> = {}): Promise<DexSetupResult> {
  const fullConfig: DexSetupConfig = {
    ...DEFAULT_DEX_CONFIG,
    ...config,
    token: { ...DEFAULT_DEX_CONFIG.token, ...config.token },
    liquidity: { ...DEFAULT_DEX_CONFIG.liquidity, ...config.liquidity },
  };

  console.log('🚀 FULL DEX SETUP');
  console.log('='.repeat(60));
  console.log('This script will:');
  console.log('  1. Deploy a test ERC20 token');
  console.log('  2. Deploy Uniswap V2 (WETH, Factory, Router)');
  console.log('  3. Create a Token/WETH liquidity pool');
  console.log('  4. Add initial liquidity for swapping');
  console.log('='.repeat(60));

  // Connect to provider
  const publicClient = createPublicClient({ transport: http(fullConfig.rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = {
    id: chainId,
    name: 'Custom',
    network: 'custom',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [fullConfig.rpcUrl] } },
  } as const;
  const deployer = privateKeyToAccount(fullConfig.deployerPrivateKey as Hex);
  const walletClient = createWalletClient({
    account: deployer,
    chain: chain as any,
    transport: http(fullConfig.rpcUrl),
  });

  console.log(`\n🔗 RPC: ${fullConfig.rpcUrl}`);
  console.log(`💰 Deployer: ${deployer.address}`);

  const initialBalance = await publicClient.getBalance({ address: deployer.address });
  console.log(`   Balance: ${formatEther(initialBalance)} ETH`);

  // =========================================================================
  // Step 1: Deploy Token
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('📦 STEP 1: Deploying Test Token...');
  console.log('─'.repeat(60));

  const tokenResult = await deployToken({
    rpcUrl: fullConfig.rpcUrl,
    deployerPrivateKey: fullConfig.deployerPrivateKey,
    tokenName: fullConfig.token.name,
    tokenSymbol: fullConfig.token.symbol,
    tokenDecimals: fullConfig.token.decimals,
    initialSupply: fullConfig.token.initialSupply,
  });

  const tokenAddress = tokenResult.contractAddress;
  const tokenAbi = tokenResult.abi;
  console.log(`✅ Token deployed: ${tokenAddress}`);

  // =========================================================================
  // Step 2: Deploy Uniswap V2
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🦄 STEP 2: Deploying Uniswap V2...');
  console.log('─'.repeat(60));

  const uniswapResult = await deployUniswap({
    rpcUrl: fullConfig.rpcUrl,
    deployerPrivateKey: fullConfig.deployerPrivateKey,
  });

  const wethAddress = uniswapResult.weth.address;
  const factoryAddress = uniswapResult.factory.address;
  const routerAddress = uniswapResult.router.address;
  const routerAbi = uniswapResult.router.abi;
  const factoryAbi = uniswapResult.factory.abi;

  console.log(`✅ WETH: ${wethAddress}`);
  console.log(`✅ Factory: ${factoryAddress}`);
  console.log(`✅ Router: ${routerAddress}`);

  // =========================================================================
  // Step 3: Approve Router to spend tokens
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🔓 STEP 3: Approving Router to spend tokens...');
  console.log('─'.repeat(60));

  const tokenAmountWei = parseUnits(fullConfig.liquidity.tokenAmount, fullConfig.token.decimals);

  // Get fresh nonce
  let nonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: 'pending' });

  const approveHash = await walletClient.writeContract({
    account: deployer,
    chain: null,
    address: tokenAddress as `0x${string}`,
    abi: tokenAbi as Abi,
    functionName: 'approve',
    args: [routerAddress as `0x${string}`, tokenAmountWei],
    nonce: nonce++,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const allowance = (await publicClient.readContract({
    address: tokenAddress as `0x${string}`,
    abi: tokenAbi as Abi,
    functionName: 'allowance',
    args: [deployer.address, routerAddress as `0x${string}`],
  })) as bigint;
  console.log(`✅ Approved ${formatUnits(allowance, fullConfig.token.decimals)} ${fullConfig.token.symbol} for Router`);

  // =========================================================================
  // Step 4: Add Liquidity (creates pool automatically)
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('💧 STEP 4: Adding Liquidity (Token/ETH pool)...');
  console.log('─'.repeat(60));

  const ethAmountWei = parseEther(fullConfig.liquidity.ethAmount);

  console.log(`   Token amount: ${fullConfig.liquidity.tokenAmount} ${fullConfig.token.symbol}`);
  console.log(`   ETH amount: ${fullConfig.liquidity.ethAmount} ETH`);
  console.log(
    `   Price: 1 ETH = ${Number(fullConfig.liquidity.tokenAmount) / Number(fullConfig.liquidity.ethAmount)} ${fullConfig.token.symbol}`,
  );

  // Deadline: 20 minutes from now
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60;

  const addLiquidityHash = await walletClient.writeContract({
    account: deployer,
    chain: null,
    address: routerAddress as `0x${string}`,
    abi: routerAbi as Abi,
    functionName: 'addLiquidityETH',
    args: [
      tokenAddress as `0x${string}`,
      tokenAmountWei,
      tokenAmountWei,
      ethAmountWei,
      deployer.address,
      BigInt(deadline),
    ],
    value: ethAmountWei,
    nonce: nonce++,
    gas: 5_000_000n,
  });

  console.log(`   Tx hash: ${addLiquidityHash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: addLiquidityHash });
  console.log(`✅ Liquidity added! Gas used: ${receipt.gasUsed.toString()}`);

  // =========================================================================
  // Step 5: Verify Pool Creation
  // =========================================================================
  console.log('\n' + '─'.repeat(60));
  console.log('🔍 STEP 5: Verifying Pool...');
  console.log('─'.repeat(60));

  const pairAddress = (await publicClient.readContract({
    address: factoryAddress as `0x${string}`,
    abi: factoryAbi as Abi,
    functionName: 'getPair',
    args: [tokenAddress as `0x${string}`, wethAddress as `0x${string}`],
  })) as `0x${string}`;

  if (pairAddress === zeroAddress) {
    throw new Error('Pair was not created!');
  }

  console.log(`✅ Pair address: ${pairAddress}`);

  // Get pair reserves
  const pairAbi = parseAbi([
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function totalSupply() view returns (uint256)',
  ]);
  const [reserve0, reserve1] = (await publicClient.readContract({
    address: pairAddress,
    abi: pairAbi,
    functionName: 'getReserves',
  })) as readonly [bigint, bigint, number];
  const token0 = (await publicClient.readContract({
    address: pairAddress,
    abi: pairAbi,
    functionName: 'token0',
  })) as `0x${string}`;
  const lpSupply = (await publicClient.readContract({
    address: pairAddress,
    abi: pairAbi,
    functionName: 'totalSupply',
  })) as bigint;

  // Determine which reserve is which
  const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
  const tokenReserve = isToken0 ? reserve0 : reserve1;
  const wethReserve = isToken0 ? reserve1 : reserve0;

  console.log(`   Token reserve: ${formatUnits(tokenReserve, fullConfig.token.decimals)} ${fullConfig.token.symbol}`);
  console.log(`   WETH reserve: ${formatEther(wethReserve)} WETH`);
  console.log(`   LP tokens minted: ${formatEther(lpSupply)}`);

  // =========================================================================
  // Summary
  // =========================================================================
  const finalBalance = await publicClient.getBalance({ address: deployer.address });
  const ethSpent = initialBalance - finalBalance;

  console.log('\n' + '='.repeat(60));
  console.log('🎉 DEX SETUP COMPLETE!');
  console.log('='.repeat(60));
  console.log('\n📝 DEPLOYED CONTRACTS:');
  console.log(`   Token (${fullConfig.token.symbol}):  ${tokenAddress}`);
  console.log(`   WETH:              ${wethAddress}`);
  console.log(`   Factory:           ${factoryAddress}`);
  console.log(`   Router:            ${routerAddress}`);
  console.log(`   Pair:              ${pairAddress}`);

  console.log('\n💱 POOL INFO:');
  console.log(
    `   Token/ETH Price: 1 ETH = ${Number(fullConfig.liquidity.tokenAmount) / Number(fullConfig.liquidity.ethAmount)} ${fullConfig.token.symbol}`,
  );
  console.log(
    `   Token/ETH Price: 1 ${fullConfig.token.symbol} = ${Number(fullConfig.liquidity.ethAmount) / Number(fullConfig.liquidity.tokenAmount)} ETH`,
  );

  console.log('\n💰 COST:');
  console.log(`   ETH spent: ${formatEther(ethSpent)} ETH`);
  console.log(`   Remaining balance: ${formatEther(finalBalance)} ETH`);

  console.log('='.repeat(60));

  return {
    token: {
      address: tokenAddress,
      abi: tokenAbi,
      name: fullConfig.token.name,
      symbol: fullConfig.token.symbol,
      decimals: fullConfig.token.decimals,
    },
    weth: {
      address: wethAddress,
    },
    factory: {
      address: factoryAddress,
      abi: factoryAbi,
    },
    router: {
      address: routerAddress,
      abi: routerAbi,
    },
    pair: {
      address: pairAddress,
    },
    deployer: deployer.address,
  };
}

export default { setupDex, DEFAULT_DEX_CONFIG };
