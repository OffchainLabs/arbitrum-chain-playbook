import { createPublicClient, createWalletClient, formatEther, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRequire } from 'module';
import { UniswapDeployConfig, UniswapDeployResult } from './types.js';

/**
 * Uniswap V2 Deployment (viem)
 *
 * Deploys the complete Uniswap V2 stack using official Uniswap npm packages:
 * - @uniswap/v2-core (Factory, Pair)
 * - @uniswap/v2-periphery (Router02, WETH9)
 */

// =============================================================================
// Import Official Uniswap Contracts
// =============================================================================

// Create require function for ESM compatibility
const require = createRequire(import.meta.url);

// These will be loaded dynamically to avoid ESM/CJS issues
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UniswapV2Factory: { abi: any; bytecode: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let UniswapV2Router02: { abi: any; bytecode: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WETH9: { abi: any; bytecode: string };

function loadUniswapContracts(): void {
  try {
    UniswapV2Factory = require('@uniswap/v2-core/build/UniswapV2Factory.json');
    UniswapV2Router02 = require('@uniswap/v2-periphery/build/UniswapV2Router02.json');
    WETH9 = require('@uniswap/v2-periphery/build/WETH9.json');
  } catch (err) {
    throw new Error(
      `Failed to load Uniswap contracts. Make sure @uniswap/v2-core and @uniswap/v2-periphery are installed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_UNISWAP_CONFIG: UniswapDeployConfig = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
};

// =============================================================================
// Deployment
// =============================================================================

export async function deployUniswap(config: Partial<UniswapDeployConfig> = {}): Promise<UniswapDeployResult> {
  const fullConfig: UniswapDeployConfig = { ...DEFAULT_UNISWAP_CONFIG, ...config };

  // Load contracts
  loadUniswapContracts();

  console.log('\n' + '='.repeat(50));
  console.log('🦄 Deploying Uniswap V2');
  console.log('='.repeat(50));

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

  console.log(`   Deployer: ${deployer.address}`);

  const balance = await publicClient.getBalance({ address: deployer.address });
  console.log(`   Balance:  ${formatEther(balance)} ETH`);

  // Get nonce for sequential deployment
  let nonce = await publicClient.getTransactionCount({ address: deployer.address, blockTag: 'pending' });

  // 1. Deploy WETH9
  console.log('\n📤 Deploying WETH9...');
  const wethHash = await walletClient.deployContract({
    account: deployer,
    chain: null,
    abi: WETH9.abi as Abi,
    bytecode: (WETH9.bytecode.startsWith('0x') ? WETH9.bytecode : `0x${WETH9.bytecode}`) as Hex,
    nonce: nonce++,
  });
  const wethReceipt = await publicClient.waitForTransactionReceipt({ hash: wethHash });
  const wethAddress = wethReceipt.contractAddress;
  if (!wethAddress) {
    throw new Error('WETH9 deployment failed to return address');
  }
  console.log(`   ✅ WETH9: ${wethAddress}`);

  // 2. Deploy UniswapV2Factory
  console.log('\n📤 Deploying UniswapV2Factory...');
  const factoryHash = await walletClient.deployContract({
    account: deployer,
    chain: null,
    abi: UniswapV2Factory.abi as Abi,
    bytecode: (UniswapV2Factory.bytecode.startsWith('0x')
      ? UniswapV2Factory.bytecode
      : `0x${UniswapV2Factory.bytecode}`) as Hex,
    args: [deployer.address],
    nonce: nonce++,
  });
  const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
  const factoryAddress = factoryReceipt.contractAddress;
  if (!factoryAddress) {
    throw new Error('Factory deployment failed to return address');
  }
  console.log(`   ✅ Factory: ${factoryAddress}`);

  // 3. Deploy UniswapV2Router02
  console.log('\n📤 Deploying UniswapV2Router02...');
  const routerHash = await walletClient.deployContract({
    account: deployer,
    chain: null,
    abi: UniswapV2Router02.abi as Abi,
    bytecode: (UniswapV2Router02.bytecode.startsWith('0x')
      ? UniswapV2Router02.bytecode
      : `0x${UniswapV2Router02.bytecode}`) as Hex,
    args: [factoryAddress, wethAddress],
    nonce: nonce++,
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerHash });
  const routerAddress = routerReceipt.contractAddress;
  if (!routerAddress) {
    throw new Error('Router deployment failed to return address');
  }
  console.log(`   ✅ Router: ${routerAddress}`);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📋 Uniswap V2 Deployment Summary');
  console.log('='.repeat(50));
  console.log(`WETH9:    ${wethAddress}`);
  console.log(`Factory:  ${factoryAddress}`);
  console.log(`Router:   ${routerAddress}`);
  console.log('='.repeat(50));

  return {
    weth: {
      address: wethAddress,
      abi: WETH9.abi as unknown[],
    },
    factory: {
      address: factoryAddress,
      abi: UniswapV2Factory.abi as unknown[],
    },
    router: {
      address: routerAddress,
      abi: UniswapV2Router02.abi as unknown[],
    },
    deployer: deployer.address,
  };
}

export default { deployUniswap, DEFAULT_UNISWAP_CONFIG };
