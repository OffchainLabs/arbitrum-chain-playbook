# Malicious Validator Playbook

A playbook for simulating and testing malicious validator behaviors in Arbitrum chains for educational and security testing purposes.

## Overview

The Malicious Validator playbook allows you to run two self-contained demos that demonstrate different attack scenarios on Arbitrum Orbit chains:

1. **Malicious Mint Demo** — A malicious sequencer uses a custom ArbMinter precompile to mint ETH out of thin air, then withdraws it to the parent chain.
2. **Challenge Demo (BoLD)** — A malicious validator creates invalid state via ReadInboxMessage bit-flip, and an honest validator challenges it using the BoLD (Bounded Liquidity Delay) protocol.

> **Important**: Both demos are **fully self-contained** — they automatically deploy a fresh chain, apply configurations, and start nodes. You do **not** need to manually deploy a chain or start nodes beforehand. Even if you already deployed a chain, the demo will redeploy and overwrite it. Simply enter **Chain Mode**, go straight to the playbook, and let the program handle everything.

## Supported Operation Modes

- **Chain Mode** only

## Menu Options

```
? Select an action:
❯ Run Malicious Mint Demo — Full cross-chain malicious mint flow
  Run Challenge Demo — Honest vs malicious validator challenge
  ──────────────
  Start Malicious Node — Launch a misconfigured validator
  Configure Malicious Validator — Modify node-config.json
  View Rollup Status — Check on-chain rollup state
  View Node Status — Show running node info
  Stop All Nodes — Terminate all running nodes
  ──────────────
  ← Back to Playbook List
```

The top two options are the main demos (recommended). The remaining options are for manual/advanced usage.

## Demo 1: Malicious Mint Demo

Demonstrates a full attack scenario: a malicious sequencer uses a custom ArbMinter precompile to mint ETH out of thin air, then withdraws it to the parent chain.

### How to Run

1. Start the CLI (`yarn start`)
2. Select **Chain Mode**
3. Select **Playbook List** → **Malicious Validator**
4. Select **Run Malicious Mint Demo**
5. Choose whether to use default deposit amounts or customize them
6. Confirm to start — the demo handles everything automatically

### Demo Flow (11 Steps)

| Step | Action | Details |
|------|--------|---------|
| 1 | **Deploy chain** | Fresh chain with `confirmPeriodBlocks=16` for quick withdrawal |
| 2 | **Apply config & start node** | Applies malicious mint config flags (`malicious-mint`, `deleting-bold-strategy`, fast validator, fast batch poster, block validator with local WASM) and starts node with `jasonwan123/nitro-node-malicious-arbminter` image |
| 3 | **Check bridge balance** | Record initial bridge balance on parent chain |
| 4 | **Deposit ETH** | Main account deposits ETH from parent chain to child chain |
| 5 | **Fund Hacker** | Generate a random Hacker account, fund it with gas, and deposit to L2 |
| 6 | **Wait for funds** | Wait for deposits to arrive on child chain (up to ~120s) |
| 7 | **Malicious mint** | Hacker calls `ArbMinter.mintBalanceTo` at `0x74` to mint ETH (invalid state) |
| 8 | **Withdraw** | Hacker calls `ArbSys.withdrawEth` at `0x64` to withdraw minted funds to L1 |
| 9 | **Start monitor** | Start rollup assertion monitor (tracks `AssertionCreated`/`AssertionConfirmed`) |
| 10 | **Wait for withdrawal** | Poll until withdrawal is confirmed and execute on L1 |
| 11 | **Final check** | Compare bridge balance before and after |

### Default Parameters

| Parameter | Value |
|-----------|-------|
| `mainDepositAmount` | 0.005 ETH |
| `hackerDepositAmount` | 0.001 ETH |
| `hackerFundingAmount` | 0.002 ETH (gas) |
| `confirmPeriodBlocks` | 16 |

### Docker Image

`jasonwan123/nitro-node-malicious-arbminter` — Nitro node with built-in ArbMinter precompile at `0x74`.

## Demo 2: Challenge Demo (BoLD)

Demonstrates the BoLD (Bounded Liquidity Delay) challenge protocol: a malicious validator creates invalid state via ReadInboxMessage bit-flip, and an honest validator challenges it.

### How to Run

1. **Build the malicious validator image** (see [Prerequisites](#build-malicious-validator-image-challenge-demo-only) below)
2. Start the CLI (`yarn start`)
3. Select **Chain Mode**
4. Select **Playbook List** → **Malicious Validator**
5. Select **Run Challenge Demo**
6. Choose whether to use default configuration or customize (max wait time, delayed message count, L2 tx count)
7. Confirm to start — the demo handles everything automatically

### Demo Flow (8 Steps)

| Step | Action | Details |
|------|--------|---------|
| 1 | **Deploy chain** | Fresh chain with `confirmPeriodBlocks=1600`, convert ETH to WETH, approve `EdgeChallengeManager` for both validators |
| 2 | **Generate configs** | Create `node-config-malicious.json` (with `validation.wasm.malicious-mode=true`) and `node-config-honest.json` (staker in MakeNodes mode) |
| 3 | **Start malicious node** | Launch malicious validator with locally-built `nitro-malicious-playbook-challenge-demo:latest` image |
| 4 | **Start honest node** | Launch honest validator with `offchainlabs/nitro-node:v3.9.6-91bf578-validator` image |
| 5 | **Send delayed messages** | Send L1 deposit transactions to create agreed execution prefix |
| 6 | **Wait for batch posting** | Wait for delayed sequencer + batch poster to process messages (~60s) |
| 7 | **Send L2 transactions** | Send transactions on child chain to trigger state divergence |
| 8 | **Monitor challenge** | Watch for BoLD challenge events until `EdgeConfirmedByOneStepProof` |

### Challenge Bisection Levels

The BoLD challenge protocol uses three levels of bisection:

| Level | Name | Description |
|-------|------|-------------|
| 0 | Block | Block-level bisection |
| 1 | BigStep | Big-step bisection |
| 2 | SmallStep | Small-step bisection (resolves via one-step proof) |

The challenge monitor tracks three core events:
- **EdgeAdded** — New edge created at a bisection level
- **EdgeBisected** — Edge split into lower/upper children
- **EdgeConfirmedByOneStepProof** — Terminal event: honest validator wins

### Default Parameters

| Parameter | Value |
|-----------|-------|
| `maxWaitSeconds` | 10800 (3 hours) |
| `pollIntervalMs` | 3000 (3 seconds) |
| `delayedMessageCount` | 10 |
| `delayedMessageAmount` | 0.0001 ETH per message |
| `childChainTxCount` | 5 |
| `confirmPeriodBlocks` | 1600 |

### Docker Images

| Role | Image |
|------|-------|
| Malicious validator | `nitro-malicious-playbook-challenge-demo:latest` (locally built, see below) |
| Honest validator | `offchainlabs/nitro-node:v3.9.6-91bf578-validator` |

### Notes

- The demo will check for the malicious image before starting. If it's not found, you'll be prompted to build it first.
- The challenge process typically takes 30–60 minutes, but may take longer depending on network conditions.
- It is recommended to use a third-party or paid RPC provider (e.g., Alchemy, Infura) to avoid rate limiting from public endpoints.

## Prerequisites

### General

- Docker must be running
- `PARENT_CHAIN_RPC` and `MAIN_PRIVATE_KEY` set in `.env`

### Build Malicious Validator Image (Challenge Demo Only)

The Challenge Demo requires a locally-built malicious validator Docker image. You must build it before running the demo.

```bash
# 1. Clone the repo with submodules
git clone --depth 1 \
  --branch malicious-validator-readInbox \
  --recurse-submodules --shallow-submodules \
  https://github.com/OffchainLabs/nitro.git nitro-remote-build
cd nitro-remote-build

# 2. Build the Docker image (~15-20 minutes)
docker build -f Dockerfile.malicious -t nitro-malicious-remote-test .

# 3. Tag it for the playbook
docker tag nitro-malicious-remote-test nitro-malicious-playbook-challenge-demo:latest
```

> **Note:** The build compiles Rust (prover, jit), Solidity contracts, and Go binaries — it takes ~15–20 minutes. You only need to do this once.

You can verify the build succeeded by checking the module root hash:

```bash
docker run --rm --entrypoint cat nitro-malicious-playbook-challenge-demo:latest \
  /home/user/target/machines/latest/module-root.txt
# Expected: 0xc2c02df561d4afaf9a1d6785f70098ec3874765c638e3cb6dbe8d3c83333e14c
```

## Configuration

The playbook manages these configuration files (generated automatically):

| File | Purpose |
|------|---------|
| `node-config.json` | Base node config (generated at chain deployment) |
| `node-config-malicious.json` | Malicious validator config (Challenge Demo) |
| `node-config-honest.json` | Honest validator config (Challenge Demo) |

Available config overlay types:
- `malicious-mint` — Enable malicious ArbMinter precompile mode
- `malicious-validator` — Skip block validation
- `incorrect-wasm-validator` — Use wrong WASM module
- `fast-batch-poster` — Fast batch posting interval
- `deleting-bold-strategy` — BoLD deletion strategy

## Troubleshooting

### Node Won't Start
- Check Docker is running
- Verify the required Docker image exists (`docker images`)
- Ensure ports are not already in use
- Check container logs: `docker logs <container-name>`

### Challenge Demo: Image Not Found
- The demo checks for `nitro-malicious-playbook-challenge-demo:latest` before starting
- Build it following the [Prerequisites](#build-malicious-validator-image-challenge-demo-only) section

### Demo Fails Mid-way
- Both demos require a clean on-chain state (no prior assertions beyond genesis)
- The demos auto-detect dirty state and will redeploy if needed
- If nodes are running, stop them first via **Stop All Nodes** before retrying

### RPC Rate Limiting
- The Challenge Demo polls on-chain logs frequently
- Use a paid RPC provider (Alchemy, Infura) instead of public endpoints

## See Also

- [Main README](../../../README.md) — General project documentation and quick start
- [Developer Guide](../../../readme-dev.md) — Architecture and how to add new playbooks
