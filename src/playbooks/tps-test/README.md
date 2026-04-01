# TPS Battle Test Playbook

A comprehensive stress testing tool for measuring the maximum Transactions Per Second (TPS) of Arbitrum Nitro nodes. This playbook provides detailed performance analysis, transaction verification, and visual reporting.

## ⚠️ Disclaimer

This is a **TypeScript/Node.js-based** TPS testing tool. Due to Node.js's single-threaded nature, it **cannot fully saturate chain throughput** under high concurrency scenarios. The measured TPS may be bottlenecked by the tool itself rather than the chain. For serious TPS benchmarking, use a multi-threaded tool written in Go or Rust. **This tool is just for fun and quick sanity checks!**

## Overview

The TPS Battle Test playbook is designed to stress test Arbitrum Nitro nodes by sending large volumes of transactions and measuring the system's throughput. It supports multiple transaction types, parallel execution, and provides detailed analytics.

## Features

- **Multiple Test Presets**: Quick, Medium, and Stress test configurations
- **Custom Configuration**: Full control over all test parameters
- **Mixed Transaction Types**: Support for ETH transfers, ERC20 token transfers, and Uniswap swaps
- **Automatic Contract Deployment**: Deploys ERC20 tokens and Uniswap V2 contracts as needed
- **Real-time Analysis**: Live TPS calculation and transaction tracking
- **Detailed Reporting**: Comprehensive test reports with statistics
- **Parallel Execution**: Multiple sender accounts with proper nonce management
- **On-chain Verification**: Verify transactions are included in blocks

## Available Test Modes

### Quick Test
- **Transactions**: 5,000
- **Default Senders**: 500
- **Default Concurrency**: 300 requests
- **Use Case**: Fast validation of node performance

### Medium Test
- **Transactions**: 10,000
- **Default Senders**: 1,000
- **Default Concurrency**: 800 requests
- **Use Case**: Moderate stress testing

### Stress Test
- **Transactions**: 50,000
- **Default Senders**: 5,000
- **Default Concurrency**: 2,000 requests
- **Use Case**: Maximum load testing (may take several minutes)

### Custom Test
- **Fully Configurable**: All parameters can be customized
- **Additional Options**: Individual transaction verification
- **Use Case**: Fine-tuned testing scenarios

### Mixed Test
- **Transaction Mix**: ETH transfers, token transfers, and Uniswap swaps
- **Configurable Ratios**: Set percentages for each transaction type
- **Auto Contract Deployment**: Deploys contracts if not present
- **Use Case**: Real-world transaction pattern simulation

## Configuration Parameters

When running any test, you'll be prompted for the following parameters:

### Funder Private Key
- **Description**: The private key of the account that will fund all sender accounts
- **Default Behavior**: 
  - Devnode Mode: Uses pre-funded dev account
  - Chain/Remote RPC Mode: Uses `MAIN_PRIVATE_KEY` environment variable
- **Tip**: Leave empty to use the default account

### RPC URL
- **Description**: The RPC endpoint URL for the chain you want to test
- **When Asked**: Custom Test and Mixed Test only
- **Default**: Automatically detected from running nodes
- **Format**: `http://127.0.0.1:8547` or `ws://127.0.0.1:8548`

### Number of Sender Accounts
- **Description**: How many unique accounts will send transactions
- **Impact**: 
  - More senders = better parallelization and nonce management
  - Higher values can improve TPS but require more funding
- **Recommended**: 
  - Quick: ~500
  - Medium: ~1,000
  - Stress: ~5,000

### Max Concurrent HTTP Requests
- **Description**: Maximum number of simultaneous RPC requests
- **Impact**: 
  - Higher values can increase throughput
  - May overwhelm the node or hit rate limits if too high
- **Recommended**: 
  - Depends on node capacity

### Gas Price Multiplier
- **Description**: Multiplier for the base gas price
- **Default**: 4x
- **Impact**: 
  - Higher values prioritize your transactions
  - Increases transaction costs
- **Recommended**: 
  - Normal conditions: 4x
  - Heavy load: 6-10x
  - Competing transactions: 8-12x

### Total Transactions to Send
- **Description**: The total number of transactions to broadcast
- **When Asked**: Custom Test and Mixed Test only
- **Considerations**: 
  - Higher values = longer test duration
  - More transactions = better statistical accuracy

### Verify All Transactions
- **Description**: Individually verify each transaction on-chain
- **When Asked**: Custom Test only
- **Trade-off**: 
  - Enabled: Slower but 100% accurate
  - Disabled: Faster execution (default)

### Transaction Mix Percentages (Mixed Test Only)
- **ETH Transfer Percentage**: Percentage of transactions that are ETH transfers (0-100)
- **Token Transfer Percentage**: Percentage of transactions that are ERC20 token transfers (0-100)
- **Swap Percentage**: Auto-calculated to make total 100%
- **Example**: 50% ETH, 30% Token, 20% Swap

## Usage Examples

### Running a Quick Test

1. Start the CLI and select your operation mode
2. Navigate to **Playbook List** → **TPS Battle Test**
3. Select **🚀 Quick Test**
4. Enter your funder private key (or press Enter for default)
5. Configure sender count and concurrency (or use defaults)
6. Set gas multiplier (or use default 4x)
7. Confirm to start the test

### Running a Custom Test

1. Select **⚙️ Custom Test**
2. Enter RPC URL (or use default)
3. Enter funder private key
4. Set total transactions (e.g., 5,0000)
5. Set number of senders (e.g., 5000)
6. Set concurrent requests (e.g., 2000)
7. Set gas multiplier (e.g., 6)
8. Choose whether to verify all transactions
9. Confirm to start

### Running a Mixed Test

1. Select **🔀 Mixed Transaction Test**
2. Enter RPC URL (or use default)
3. Enter funder private key
4. Set total transactions (e.g., 50,000)
5. Configure senders and concurrency
6. Set gas multiplier
7. Set ETH transfer percentage (e.g., 50%)
8. Set token transfer percentage (e.g., 30%)
9. Swap percentage will be auto-calculated (20%)
10. Confirm to start

## Contract Deployment

The playbook can automatically deploy contracts when needed:

### ERC20 Token Deployment
- Deploys a standard ERC20 token with configurable name, symbol, and supply
- Uses OpenZeppelin contracts
- All tokens are minted to the deployer

### Uniswap V2 Deployment
- Deploys WETH9, Factory, and Router02 contracts
- Uses official Uniswap V2 contracts from npm packages
- Required for swap transactions in Mixed Test

### Full DEX Setup
- Deploys token, Uniswap contracts, and adds liquidity
- Creates a complete DEX environment
- Useful for comprehensive testing scenarios

## Test Report

After a test completes, you'll receive a detailed report including:

- **Total Transactions**: Sent, confirmed, and failed
- **TPS Metrics**: Average, peak, and sustained TPS
- **Block Statistics**: Blocks analyzed, transactions per block
- **Gas Analysis**: Total gas used, average gas per transaction
- **Timing**: Test duration, average block time


## Supported Operation Modes

- ✅ **Chain Mode**: Test your deployed chain
- ✅ **Devnode Mode**: Test local devnode (recommended for development)
- ✅ **Remote RPC Mode**: Test remote chains via RPC

## Troubleshooting

### Transactions Not Confirming
- Increase gas multiplier
- Reduce concurrent requests
- Check node is synced and healthy

### High Error Rate
- Reduce concurrent requests
- Check RPC endpoint is accessible
- Verify node has sufficient resources

### Slow Performance
- Increase concurrent requests (if node can handle it)
- Use more sender accounts
- Check network latency

### Contract Deployment Fails
- Ensure funder account has sufficient balance
- Check OpenZeppelin/Uniswap packages are installed
- Verify RPC endpoint is working

## Technical Details

- **Transaction Types**: ETH transfers, ERC20 transfers, Uniswap swaps
- **Nonce Management**: Automatic per-account nonce tracking
- **Parallel Broadcasting**: Concurrent transaction submission
- **Block Analysis**: Real-time block monitoring and analysis
- **Error Handling**: Comprehensive error tracking and reporting

## Dependencies

- `viem`: Ethereum interaction library
- `@openzeppelin/contracts`: ERC20 token contracts
- `@uniswap/v2-core`: Uniswap V2 core contracts
- `@uniswap/v2-periphery`: Uniswap V2 periphery contracts
- `solc`: Solidity compiler

## See Also

- [Main README](../../../README.md) - General project documentation
- [Developer Guide](../../../readme-dev.md) - Architecture and development guide
