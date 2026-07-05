# Arbitrum Chain Playbook

An interactive CLI tool for deploying and operating Arbitrum Orbit chains, managing Nitro nodes via Docker, and running scenario playbooks.

If you want to know the structure of this project and how to add playbooks, please refer to [readme-dev](./readme-dev.md).

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Operation Modes](#operation-modes)
  - [Chain Mode](#chain-mode)
  - [Devnode Mode](#devnode-mode)
  - [Remote RPC Mode](#remote-rpc-mode)
- [Main Menu Options](#main-menu-options)
- [Playbooks](#playbooks)
- [Environment Variables](#environment-variables)
- [For Developers](#for-developers)

## Features

- **Chain Deployment**: Deploy a new Arbitrum Orbit chain with automated configuration
- **Node Management**: Start, stop, and monitor Nitro nodes via Docker containers

- **State Reconstruction**: Restore chain state from deployment transaction hash
- **Playbooks**: Run modular playbooks for testing and demonstrations
- **Multiple Modes**: Support for local devnode, custom chain, and remote RPC connections

## Prerequisites

- **Node.js** v22.x (Node 23+ is not yet supported — `ts-node/esm` hits a `require()` cycle error there)
- **Docker** (for running Nitro nodes)
- **Yarn** or **npm**

## Installation

```bash
# Clone the repository with submodules
git clone --recurse-submodules https://github.com/OffchainLabs/arbitrum-chain-playbook.git
cd arbitrum-chain-playbook

# If already cloned without submodules:
git submodule update --init --recursive

# Install dependencies
yarn install
# or
npm install
```

## Quick Start

```bash
# Start the CLI
yarn start
# or
npm start

# Development mode (auto-reload)
yarn dev
# or
npm run dev
```

On startup, you'll be prompted to select an operation mode.

## Operation Modes

The CLI supports three operation modes, each suited for different use cases.

### Chain Mode

Deploy and manage your own Arbitrum Orbit chain.

**Use case**: Full chain deployment and node management on a parent chain (e.g., Arbitrum Sepolia).

(Chain mode can deploy a new chain but can also manage an existing chain as if you provide `CHAIN_DEPLOYMENT_TRANSACTION_HASH`)

**Required environment variables**:
```bash
PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc
MAIN_PRIVATE_KEY=0x...  # Account with funds on parent chain
```

**Optional**:
```bash
CHAIN_DEPLOYMENT_TRANSACTION_HASH=0x...  # Restore existing chain state
```

**What you can do**:
- Deploy a new chain
- Start/stop Nitro nodes
- Configure chain parameters
- Run playbooks

### Devnode Mode

Run a local Nitro devnode for quick testing without deploying a chain.

**Use case**: Local development and testing.

**No configuration required** - just select "Start Devnode Mode" from the menu.

**Default settings**:
| Setting | Value |
|---------|-------|
| Container | `nitro-dev` |
| RPC URL | `http://127.0.0.1:8547` |
| WS URL | `ws://127.0.0.1:8548` |
| Chain ID | `412346` |
| Dev Account | Pre-funded, auto-loaded |

**What you can do**:
- Manage devnode container
- View status
- Run playbooks

### Remote RPC Mode

Connect to an already-deployed remote chain.

**Use case**: Interact with an existing chain without running local nodes.

**Required environment variables**:
```bash
PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc
CHAIN_RPC=https://your-orbit-chain-rpc.com
CHAIN_DEPLOYMENT_TRANSACTION_HASH=0x...
MAIN_PRIVATE_KEY=0x...  # Optional, for signing transactions
```

**What you can do**:
- Interact with the chain
- View status
- Run playbooks

## Main Menu Options

| Option | Description | Available In |
|--------|-------------|--------------|
| **Deploy New Chain** | Deploy an Orbit chain to parent chain | Chain Mode |
| **Manage Nodes** | Start/stop/monitor main Nitro nodes | Chain, Devnode |

| **Interact with Chain** | Send transactions, query state | All Modes |
| **View Status** | Display chain and node information | All Modes |
| **Node Config Operations** | Modify node configuration files | Chain Mode |
| **Playbook List** | Run available playbooks | All Modes |

**Note**: The **Manage Nodes** menu is for starting standard main nodes (with sequencer, batch poster, and staker components). Specialized validators (malicious, honest challenge validators) are started through their respective playbooks to ensure proper configuration and clean state requirements.

## Playbooks

The CLI includes modular playbooks for testing and demonstrations. Access playbooks from the main menu by selecting **Playbook List**.

### Available Playbooks

- **Malicious Validator**: Simulate and test malicious validator behaviors for educational and security testing purposes. Includes a Malicious Mint Demo and a BoLD Challenge Demo.
  - 📖 [Detailed Documentation](./src/playbooks/malicious-validator/README.md)

For more information about each playbook, including configuration options, usage examples, and troubleshooting, please refer to their respective README files linked above.

## Headless / Scripted Mode

Most playbooks can also be driven from a YAML or JSON script — no inquirer prompts, no menus. Intended for CI runs, regression checks, and AI-driven automation.

```bash
yarn run:script examples/malicious-mint.yaml
```

**Script schema**:

```yaml
mode: chain          # chain | devnode | remote
playbook: <id>       # e.g. malicious-validator
command: <command>   # e.g. malicious-mint, bold-challenge
chainRestorePolicy: auto    # auto | fresh | reuse; headless-only
orphanContainerPolicy: warn # warn | stop; headless-only pre-existing nitro-* handling
params: { ... }      # command-specific (see examples/)
timeoutSeconds: 1800 # optional hard cap; cancels the run when exceeded
```

ETH amounts in `params` are accepted as decimal strings (e.g. `"0.05"`) or numbers and converted to `bigint` wei via `parseEther`.

**Available headless commands**:

| Playbook | Command | Modes |
|---|---|---|
| `malicious-validator` | `malicious-mint` | chain |
| `malicious-validator` | `bold-challenge` | chain |

**Output**:

Each run produces several files under `./logs/`:

- `cli-<ts>.log`   — human-readable text log
- `cli-<ts>.jsonl` — one JSON object per log line (`{ts, level, message}`)
- `transcript-<ts>.log` — headless transcript of raw operator-facing output
- `events-<ts>.jsonl` — structured headless event stream when a playbook emits events
- `result-<ts>.json` — final result envelope: `{script, logFile, jsonlFile, transcriptFile, eventsFile, startedAt, finishedAt, exitCode, result, failure?}`
- `latest-result.json`, `latest-log.txt`, `latest-jsonl.txt` — pointers for tools that only need the latest run

The JSONL file is meant for tools / agents — `tail -f logs/cli-*.jsonl | jq` follows progress in real time. The text log is what humans read.

**Exit codes**:

| Code | Meaning |
|---|---|
| 0   | success |
| 1   | fatal / unexpected error |
| 2   | playbook reported failure |
| 3   | script document or env validation failed |
| 64  | usage error (missing path) |
| 130 | cancelled (timeout, SIGINT, or SIGTERM) |

**Required env vars** are the same as the corresponding interactive mode — see the [Environment Variables](#environment-variables) section.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PARENT_CHAIN_RPC` | Chain/Remote | RPC endpoint for the parent chain |
| `MAIN_PRIVATE_KEY` | Recommended | Private key for signing transactions |
| `CHAIN_DEPLOYMENT_TRANSACTION_HASH` | Remote | Transaction hash of chain deployment |
| `CHAIN_RPC` | Remote | RPC endpoint for the Orbit chain |

**Example `.env` file**:
```bash
# For Chain Mode
PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc
MAIN_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# For Remote RPC Mode (add these)
CHAIN_RPC=https://your-orbit-chain.com/rpc
CHAIN_DEPLOYMENT_TRANSACTION_HASH=0x1234...
```

## For Developers

For architecture details, API documentation, and how to add new playbooks, see [readme-dev.md](./readme-dev.md).
