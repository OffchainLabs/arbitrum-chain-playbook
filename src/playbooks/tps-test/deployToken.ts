import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import solc from 'solc';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TokenDeployConfig, TokenDeployResult } from './types.js';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * ERC20 Token Deployment (viem)
 *
 * Compiles and deploys an ERC20 token using OpenZeppelin contracts.
 * All tokens are minted to the deployer.
 */

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_TOKEN_CONFIG: TokenDeployConfig = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  deployerPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  tokenName: 'Test Token',
  tokenSymbol: 'TEST',
  tokenDecimals: 18,
  initialSupply: '1000000000', // 1 billion tokens
};

// =============================================================================
// Solidity Compiler
// =============================================================================

interface ImportCallback {
  contents?: string;
  error?: string;
}

function findImports(importPath: string): ImportCallback {
  try {
    // Handle OpenZeppelin imports - look in project root node_modules
    if (importPath.startsWith('@openzeppelin/')) {
      // Try multiple possible locations
      const possiblePaths = [
        path.join(__dirname, '..', '..', '..', 'node_modules', importPath),
        path.join(__dirname, 'node_modules', importPath),
        path.join(process.cwd(), 'node_modules', importPath),
      ];

      for (const ozPath of possiblePaths) {
        if (fs.existsSync(ozPath)) {
          const content = fs.readFileSync(ozPath, 'utf8');
          return { contents: content };
        }
      }

      return { error: `OpenZeppelin file not found: ${importPath}` };
    }

    // Handle local imports
    const localPath = path.join(__dirname, 'contracts', importPath);
    if (fs.existsSync(localPath)) {
      const content = fs.readFileSync(localPath, 'utf8');
      return { contents: content };
    }

    return { error: `File not found: ${importPath}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface CompiledContract {
  abi: Abi;
  bytecode: string;
}

export function compileContract(): CompiledContract {
  console.log('🔨 Compiling contract with OpenZeppelin...');

  const contractPath = path.join(__dirname, 'contracts', 'TestToken.sol');

  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract file not found: ${contractPath}`);
  }

  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      'TestToken.sol': {
        content: source,
      },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['*'],
        },
      },
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  // Check for errors
  if (output.errors) {
    const errors = output.errors.filter((e: { severity: string }) => e.severity === 'error');
    if (errors.length > 0) {
      console.error('Compilation errors:');
      errors.forEach((e: { formattedMessage: string }) => console.error(e.formattedMessage));
      throw new Error('Contract compilation failed');
    }

    // Print warnings
    const warnings = output.errors.filter((e: { severity: string }) => e.severity === 'warning');
    if (warnings.length > 0) {
      console.log(`   ⚠️  ${warnings.length} compiler warnings (ignored)`);
    }
  }

  const contract = output.contracts['TestToken.sol']['TestToken'];

  if (!contract) {
    throw new Error('TestToken contract not found in compilation output');
  }

  console.log('✅ Contract compiled successfully');

  return {
    abi: contract.abi,
    bytecode: contract.evm.bytecode.object,
  };
}

// =============================================================================
// Deployment
// =============================================================================

export async function deployToken(config: Partial<TokenDeployConfig> = {}): Promise<TokenDeployResult> {
  const fullConfig: TokenDeployConfig = { ...DEFAULT_TOKEN_CONFIG, ...config };

  console.log('\n' + '='.repeat(50));
  console.log('🪙 Deploying ERC20 Token');
  console.log('='.repeat(50));
  console.log(`   Name:     ${fullConfig.tokenName}`);
  console.log(`   Symbol:   ${fullConfig.tokenSymbol}`);
  console.log(`   Decimals: ${fullConfig.tokenDecimals}`);
  console.log(`   Supply:   ${fullConfig.initialSupply} tokens`);
  console.log();

  // Compile contract
  const { abi, bytecode } = compileContract();

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

  // Calculate initial supply with decimals
  const initialSupply = parseUnits(fullConfig.initialSupply, fullConfig.tokenDecimals);

  // Deploy
  console.log('\n📤 Deploying contract...');

  const bytecodeHex = (bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`) as Hex;
  const hash = await walletClient.deployContract({
    account: deployer,
    chain: null,
    abi,
    bytecode: bytecodeHex,
    args: [fullConfig.tokenName, fullConfig.tokenSymbol, fullConfig.tokenDecimals, initialSupply],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const contractAddress = receipt.contractAddress;
  if (!contractAddress) {
    throw new Error('Contract deployment failed to return address');
  }

  console.log(`✅ Contract deployed at: ${contractAddress}`);

  // Verify deployment
  const name = (await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'name',
  })) as string;
  const symbol = (await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'symbol',
  })) as string;
  const decimals = (await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'decimals',
  })) as bigint;
  const totalSupply = (await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'totalSupply',
  })) as bigint;

  console.log('\n' + '='.repeat(50));
  console.log('📋 Token Details');
  console.log('='.repeat(50));
  console.log(`Contract Address: ${contractAddress}`);
  console.log(`Token Name:       ${name}`);
  console.log(`Token Symbol:     ${symbol}`);
  console.log(`Total Supply:     ${formatUnits(totalSupply, Number(decimals))}`);
  console.log('='.repeat(50));

  return {
    contractAddress,
    abi: abi as unknown[],
    tokenName: name,
    tokenSymbol: symbol,
    tokenDecimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    deployer: deployer.address,
  };
}

export default { deployToken, compileContract, DEFAULT_TOKEN_CONFIG };
