# Agent Guide — Running Playbooks Headless

This file tells AI agents (Claude Code, Codex, etc.) how to drive this CLI without inquirer prompts, watch progress, decide pass/fail, and summarize results for the user.

If you are doing anything other than running a playbook end-to-end, ignore this file and use [README.md](./README.md).

---

## TL;DR

```bash
# 1. Pre-flight (no real spend)
docker info > /dev/null && grep -E '^(MAIN_PRIVATE_KEY|PARENT_CHAIN_RPC)=' .env

# 2. Run (background, will take 5–10 min for malicious-mint, 30–60 min for bold-challenge)
yarn run:script examples/malicious-mint.yaml

# 3. Decide pass/fail from one file
jq '.exitCode, .result.success' logs/latest-result.json
```

Exit `0` + `result.success: true` ⇒ demo worked. Anything else ⇒ inspect `logs/latest-result.json` `.failure` block then `logs/latest-log.txt`.

---

## When to use this

You're triggering this guide when the user asks any of:
- "Run the malicious-mint demo"
- "Run the BoLD challenge demo"
- "Verify a chain feature playbook end-to-end"
- "Test that the headless runner still works"

If the user wants to **add a new playbook** or **understand the architecture**, read [readme-dev.md](./readme-dev.md) instead. This file is only about *running* existing playbooks.

---

## Available headless commands

| Playbook | Command | Mode | Typical duration | Approx. Sepolia ETH |
|---|---|---|---|---|
| `malicious-validator` | `malicious-mint` | chain | 7–10 min | ~0.06 ETH |
| `malicious-validator` | `bold-challenge` | chain | 30–90 min | ~0.10 ETH |

**Both spend real Arbitrum Sepolia ETH.** Confirm with the user before kicking off a run unless they explicitly asked.

---

## Pre-flight checklist

Run all five before starting. Each takes < 1 second except the image build (skip-if-cached).

```bash
# 1. Node version (must be 22.x — Node 23+ breaks ts-node/esm, see package.json engines)
node --version | grep -E 'v22\.'

# 2. Docker daemon up
docker info > /dev/null 2>&1 && echo OK

# 3. Required env vars present
grep -E '^(MAIN_PRIVATE_KEY|PARENT_CHAIN_RPC)=.+' .env | wc -l   # expect: 2

# 4. Submodules populated (nitro-devnode pinned at 1e535a6)
test -f nitro-devnode/run-dev-node.sh && echo OK

# 5. Required Docker images (see "Obtaining Docker images" below if missing)
docker image inspect jasonwan123/nitro-node-malicious-arbminter > /dev/null 2>&1 && echo OK   # malicious-mint
docker image inspect nitro-malicious-playbook-challenge-demo:latest > /dev/null 2>&1 && echo OK # bold-challenge
```

If any check fails, follow the matching subsection below — **don't run the demo until they all pass**.

### Fixing pre-flight failures

| Failed check | Action | Cost |
|---|---|---|
| 1: Node | Tell the user; don't auto-install | — |
| 2: Docker daemon | Tell the user to start Docker Desktop | — |
| 3: env vars | Tell the user which var is missing; **never auto-write `.env`** | — |
| 4: submodule | `git submodule update --init --recursive` (pulls ~5 MB) | < 30 s |
| 5: images | See "Obtaining Docker images" — confirm with user first since the build is heavy | 0–25 min |

### Obtaining Docker images

There are two images. The first is public and pullable; the second must be built locally.

**Image 1 — `jasonwan123/nitro-node-malicious-arbminter` (malicious-mint demo)**

Public on Docker Hub. ~3.3 GB.

```bash
# Confirm with the user before pulling — this is a 3+ GB download.
docker pull jasonwan123/nitro-node-malicious-arbminter:latest
```

**Image 2 — `nitro-malicious-playbook-challenge-demo:latest` (bold-challenge demo)**

Must be built from the `nitro` repo's `Dockerfile.malicious`. Takes 15–25 minutes (compiles Rust prover + Solidity contracts + Go binaries). Build only once per machine.

```bash
# Confirm with the user before kicking this off — it's a long build.
git clone --depth 1 \
  --branch malicious-validator-readInbox \
  --recurse-submodules --shallow-submodules \
  https://github.com/OffchainLabs/nitro.git /tmp/nitro-malicious-build
cd /tmp/nitro-malicious-build
docker build -f Dockerfile.malicious -t nitro-malicious-remote-test .
docker tag nitro-malicious-remote-test nitro-malicious-playbook-challenge-demo:latest

# Optional: verify the build by checking module root hash:
docker run --rm --entrypoint cat nitro-malicious-playbook-challenge-demo:latest \
  /home/user/target/machines/latest/module-root.txt
# Expected: 0xc2c02df561d4afaf9a1d6785f70098ec3874765c638e3cb6dbe8d3c83333e14c
```

Source of truth — if the commands above drift, defer to [src/playbooks/malicious-validator/README.md](./src/playbooks/malicious-validator/README.md#build-malicious-validator-image-challenge-demo-only).

### Optional: balance + leftover container scan

```bash
# Existing nitro-* containers from previous runs
docker ps --filter "name=nitro-" --format '{{.Names}}'
```

If any are listed and you set `orphanContainerPolicy: warn` (default), the run will warn but not stop them — and a port conflict on 9642 / 8449 will likely fail the run. Two options:

- Set `orphanContainerPolicy: stop` in the YAML, **or**
- `docker stop <name>` manually before running.

---

## Running a playbook

### Step 1 — pick or write a YAML

Use the existing examples first. Only write your own if the user wants non-default params.

```bash
ls examples/
# malicious-mint.yaml
# bold-challenge.yaml
```

Minimum viable script:

```yaml
mode: chain
playbook: malicious-validator
command: malicious-mint
chainRestorePolicy: auto       # let the runner detect "this command redeploys"
orphanContainerPolicy: warn    # use "stop" to auto-clean leftover containers
params: {}                     # all-defaults; override only what user requested
# timeoutSeconds: 1800         # uncomment to add a hard cap
```

ETH amounts in `params` accept decimal strings (`"0.005"`) — converted to `bigint` wei automatically.

### Step 2 — launch in background

`yarn start` does not work for you (it spawns inquirer). Always use `yarn run:script`:

```bash
yarn run:script examples/malicious-mint.yaml > /tmp/run.stdout 2>&1 &
echo "started pid=$!"
```

Or use your harness's background-task mechanism. **Do not** keep the foreground tool blocked for 10–60 minutes.

### Step 3 — let it run, check periodically

The demo emits progress every few seconds. **Do not poll faster than 30 s** — RPC traffic is already heavy.

Sensible check cadence:

| Demo | First check | Subsequent |
|---|---|---|
| `malicious-mint` | 90 s | every 60 s |
| `bold-challenge` | 3 min | every 3 min |

---

## Watching progress (without re-reading the world)

### Pattern 1 — Has the run finished yet?

```bash
test -f logs/latest-result.json && echo DONE || echo RUNNING
```

`logs/latest-result.json` is only written **after** the run has emitted its envelope (success, failure, or cancellation). If it doesn't exist, the run is still going.

### Pattern 2 — Where in the run am I?

```bash
# Most recent step transition (latest-log.txt is a pointer file)
grep -oE '\[[0-9]+/[0-9]+\] [^"]+' "$(cat logs/latest-log.txt)" | tail -3

# Most recent EVENT marker (high-signal milestones)
grep '\[EVENT\]' "$(cat logs/latest-log.txt)" | tail -5
```

Examples of high-signal events (substring matches):
- `Chain deployed successfully` → step 1/11 done
- `Node started` → step 2/11 done
- `Hacker minted` → malicious tx confirmed
- `Withdrawal executed successfully on L1!` → demo essentially won
- `Edge Added: Block, Length=128 ... [LayerZero]` → BoLD challenge started bisecting
- `EdgeConfirmedByOneStepProof` → BoLD challenge resolved by OSP

### Pattern 3 — Streaming structured events (bold-challenge only)

`logs/latest-events.txt` is a one-line **pointer file** containing the absolute path of this run's events JSONL. Read it then tail the real file:

```bash
tail -f "$(cat logs/latest-events.txt)" | jq
# Each line: {"ts": ..., "type": "challenge", "payload": {ChallengeEvent}}
```

`malicious-mint` doesn't emit structured events; its `events-*.jsonl` will be empty (expected, not a bug). The same pointer pattern applies to `latest-log.txt`, `latest-jsonl.txt`, `latest-transcript.txt` — each contains an absolute path. `latest-result.json` is the only one that is a real JSON file, not a pointer.

---

## Deciding pass/fail (the "am I done?" check)

**Always** read `logs/latest-result.json` first. It has everything needed in one file.

```bash
jq '{exitCode, success: .result.success, failure: .failure}' logs/latest-result.json
```

| Exit code | Meaning | What to do |
|---|---|---|
| `0` | Success | Build summary for user (next section) |
| `2` | Playbook reported failure | Read `.failure.failedAtStep` + `.failure.errorMessage` |
| `3` | Validation error | YAML or env wrong — fix and re-run |
| `64` | Usage error | Wrong CLI args |
| `130` | Cancelled (timeout / SIGINT / SIGTERM) | Either user killed it or `timeoutSeconds` hit |
| `1` | Fatal / unexpected | Read `.failure.errorStack` + `logs/latest-log.txt` |

### Sanity-check `.result.data` for malicious-mint

Even on `success: true`, sanity-check the numeric fields are non-zero (the runner had a soft-failure bug class where it would return all-zeros):

```bash
jq '.result.data | {mintAmount, withdrawAmount, bridgeBalanceFinal}' logs/latest-result.json
```

If any of those are `"0"`, treat it as failure even though `success: true`.

### Sanity-check for bold-challenge

```bash
jq '.result.data | {success, winner, totalEdges, totalBisections, ospTxHash}' logs/latest-result.json
```

A real win has `winner: "honest"` and `ospTxHash: "0x..."`. `winner: "timeout"` means the demo ran out of monitor time, not that the demo logic failed — relay this nuance to the user.

---

## Summarizing for the user

Use this template after a successful run. Fill in from `logs/latest-result.json`:

### malicious-mint summary

```
✅ Malicious Mint demo completed in {duration}.

Demonstrated: a chain running a malicious ArbMinter precompile creates ETH
out of thin air, then withdraws it through the bridge — and the withdrawal
is confirmed on L1 because no honest validator is challenging.

Numbers:
  - Hacker minted:  {mintAmount} wei (≈ {mintAmount in ETH})
  - Hacker withdrew: {withdrawAmount} wei (executed on L1)
  - L1 execution tx: grep '"executeTransaction"' logs/latest-log.txt | tail -1
  - Bridge balance: {bridgeBalanceInitial} → {bridgeBalanceFinal} wei

Logs:
  - Result: logs/latest-result.json
  - Full text log: cat the path in logs/latest-log.txt
```

### bold-challenge summary

```
✅ BoLD Challenge demo completed in {duration}.

Demonstrated: an honest validator defeats a malicious validator through
multi-level bisection (Block → BigStep → SmallStep → OSP).

Numbers:
  - Edges created:    {totalEdges}
  - Bisections:       {totalBisections}
  - Winner:           {winner}
  - OSP tx hash:      {ospTxHash}

Logs:
  - Result: logs/latest-result.json
  - Structured events: cat the path in logs/latest-events.txt
  - Full text log: cat the path in logs/latest-log.txt
```

### On failure

Lead with the failure cause, not the demo description:

```
❌ {playbook}/{command} failed at step "{failure.failedAtStep}" (exit code {exitCode}).

Reason: {failure.errorMessage or .result.message}

Completed steps before failure: {failure.completedSteps}

Inspect: cat the path in logs/latest-log.txt
```

---

## Troubleshooting (you'll see these)

| Symptom | Cause | Fix |
|---|---|---|
| `port is already allocated` on 9642 / 8449 | Leftover container from previous run | Set `orphanContainerPolicy: stop`, or `docker stop nitro-*` manually |
| `node-config.json chain-id (X) does not match … chainId (Y). Refusing to overwrite` | `CHAIN_DEPLOYMENT_TRANSACTION_HASH` env var disagrees with leftover `node-config.json` | YAML should have `chainRestorePolicy: auto` (the example does); if it does, the playbook's `redeploysChain` flag may not be set. For redeployment commands this is a code bug — escalate. |
| `Insufficient balance. Current: 0.0… ETH, Required: ~0.05 ETH` | Deployer key out of Sepolia ETH | Tell the user — get from https://www.alchemy.com/faucets/arbitrum-sepolia |
| `Docker image "…" not found locally` | Image not pulled / built | See "Obtaining Docker images" above. Confirm cost (3 GB pull or 20-min build) with user before kicking off. |
| `Message status: UNCONFIRMED` for many polls in malicious-mint | Normal — assertion covering the L2 send root hasn't been confirmed yet | Wait. Up to 10 min of polling is built-in. |
| Run cancelled with exit 130 | Timeout, SIGINT, or SIGTERM | Check `.failure.failedAtStep` to see how far it got. The chain on Sepolia is real and intact. |

---

## Hard rules (do not break)

1. **Do not** keep a foreground command blocked for the entire run. Always background-and-poll.
2. **Do not** poll faster than every 30 seconds — JSON-RPC backoff is real.
3. **Do not** auto-`docker pull` (3 GB), auto-`docker build` (20 min, heavy CPU), auto-fund the deployer key, or auto-edit `.env`. Confirm the cost with the user first; only proceed on explicit go-ahead.
4. **Do not** delete `logs/`, `node-config*.json`, or `.arbitrum/` without confirming — they hold debug state for any failed run.
5. **Do not** confuse `winner: "timeout"` with demo failure. It means the monitor stopped watching, not that the protocol failed.
6. **Do not** report `success: true` without sanity-checking `.result.data` numeric fields (see "Sanity-check" sections above).
7. **Do** tell the user the approximate cost in ETH and time before kicking off a run, unless they explicitly authorized spend.
