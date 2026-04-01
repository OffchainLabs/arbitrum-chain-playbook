# Nitro Throughput Monitoring

Grafana + Prometheus stack for monitoring Arbitrum Nitro node metrics during stress testing.

## Quick Start

```bash
# Add NITRO_METRICS_URL to your project root .env file
echo "NITRO_METRICS_URL=http://<your-node>:6070/debug/metrics" >> ../.env

# Start the stack
cd monitoring
docker compose up -d --build

# Open Grafana
open http://localhost:3001
```

The docker-compose reads from the project root's `.env` file.

**Login:** admin / admin

## Key Dashboard: Nitro Throughput Analysis

The dashboard highlights the **root cause metrics** for the ~330 tx/s throughput ceiling:

### 🚨 Bottleneck Indicators (Top Row)

| Metric | Problem If | What It Means |
|--------|-----------|---------------|
| **TX per Block** | = 1 | Sequencer produces 1 tx/block instead of batching |
| **Block Creation Time** | < 5ms | Blocks created too fast, no time to batch |
| **Theoretical Max TPS** | ~300 | Confirms the ceiling: `1 tx / 3ms = 333 tx/s` |
| **Sequencer Backlog** | = 0 | No queue → no batching opportunity |

### Fix the Bottleneck

The chain is configured for **low latency** (fast block times) at the expense of **throughput**. To increase throughput:

1. **Slow down block production** - Allow more txs to accumulate per block
2. **Increase max-block-speed** - Configure in Nitro node config:

```json
{
  "sequencer": {
    "max-block-speed": "100ms"   // Default is very fast (~3ms effective)
  }
}
```

## Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Nitro Node    │    │  nitro-exporter │    │   Prometheus    │
│  :6070/debug/   │───▶│  (JSON→Prom)    │───▶│    :9090        │
│    metrics      │    │     :9091       │    │                 │
└─────────────────┘    └─────────────────┘    └────────┬────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────┐
                                              │    Grafana      │
                                              │     :3001       │
                                              └─────────────────┘
```

## Exposed Metrics

The exporter converts Nitro's JSON metrics to Prometheus format:

**Block Production:**
- `nitro_block_tx_count_mean` - Average txs per block
- `nitro_block_gas_used_mean` - Average gas per block
- `nitro_sequencer_block_creation_ns_mean` - Block creation time (ns)

**Sequencer:**
- `nitro_sequencer_backlog` - Pending tx queue depth
- `nitro_sequencer_nonce_cache_hit_total` / `miss_total` - Nonce cache efficiency

**RPC:**
- `nitro_rpc_send_tx_success_total` / `failure_total` - TX submission stats
- `nitro_send_tx_success_rate` - Derived success rate

**Derived:**
- `nitro_theoretical_tps` - Calculated max TPS based on block time + tx/block
- `nitro_nonce_cache_hit_rate` - Cache efficiency ratio

## Troubleshooting

**Exporter can't reach Nitro node:**
```bash
# Check connectivity (use your NITRO_METRICS_URL)
curl $NITRO_METRICS_URL

# Check exporter logs
docker compose logs nitro-exporter
```

**No data in Grafana:**
```bash
# Check Prometheus targets
open http://localhost:9090/targets

# Verify exporter is exposing metrics
curl http://localhost:9091/metrics
```

## Stopping

```bash
docker compose down

# Remove volumes (reset data)
docker compose down -v
```
