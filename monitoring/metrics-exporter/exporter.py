#!/usr/bin/env python3
"""
Nitro JSON Metrics to Prometheus Exporter

Fetches metrics from Nitro's /debug/metrics JSON endpoint and
exposes them in Prometheus format.
"""

import os
import re
import time
import requests
from prometheus_client import start_http_server, Gauge, Counter, REGISTRY
from prometheus_client.core import GaugeMetricFamily, CounterMetricFamily

NITRO_METRICS_URL = os.environ.get('NITRO_METRICS_URL', 'http://host.docker.internal:6070/debug/metrics')
SCRAPE_INTERVAL = int(os.environ.get('SCRAPE_INTERVAL', '5'))

# Key metrics for throughput analysis
KEY_METRICS = {
    # Block production
    'arb/block/transactions/count.mean': 'nitro_block_tx_count_mean',
    'arb/block/transactions/count.max': 'nitro_block_tx_count_max',
    'arb/block/gasused.mean': 'nitro_block_gas_used_mean',
    'arb/block/gasused.max': 'nitro_block_gas_used_max',
    'arb/block/execution.mean': 'nitro_block_execution_ns_mean',

    # Sequencer
    'arb/sequencer/backlog': 'nitro_sequencer_backlog',
    'arb/sequencer/block/creation.mean': 'nitro_sequencer_block_creation_ns_mean',
    'arb/sequencer/block/successful': 'nitro_sequencer_blocks_successful_total',
    'arb/sequencer/noncecache/hit': 'nitro_sequencer_nonce_cache_hit_total',
    'arb/sequencer/noncecache/miss': 'nitro_sequencer_nonce_cache_miss_total',
    'arb/sequencer/active': 'nitro_sequencer_active',
    'arb/sequencer/calldataunitsbacklog': 'nitro_sequencer_calldata_backlog',

    # Gas
    'arb/gas_used': 'nitro_gas_used_total',
    'arb/block/basefee': 'nitro_block_basefee',

    # Chain head
    'chain/head/block': 'nitro_chain_head_block',
    'chain/head/finalized': 'nitro_chain_head_finalized',

    # Batch poster
    'arb/batchposter/estimated_batch_backlog': 'nitro_batchposter_backlog',
    'arb/inbox/latest/batch': 'nitro_inbox_latest_batch',
    'arb/inbox/latest/batch/message': 'nitro_inbox_latest_batch_message',

    # Sequence numbers
    'arb/sequencenumber/latest': 'nitro_sequence_number_latest',
    'arb/sequencenumber/confirmed': 'nitro_sequence_number_confirmed',

    # TX Pool
    'txpool/pending': 'nitro_txpool_pending',
    'txpool/queued': 'nitro_txpool_queued',
    'txpool/slots': 'nitro_txpool_slots',

    # RPC
    'rpc/requests': 'nitro_rpc_requests_total',
    'rpc/success': 'nitro_rpc_success_total',
    'rpc/failure': 'nitro_rpc_failure_total',

    # RPC by method
    'rpc/duration/eth_sendRawTransaction/success.count': 'nitro_rpc_send_tx_success_total',
    'rpc/duration/eth_sendRawTransaction/failure.count': 'nitro_rpc_send_tx_failure_total',
    'rpc/duration/eth_getTransactionReceipt/success.count': 'nitro_rpc_get_receipt_success_total',
    'rpc/duration/eth_getTransactionCount/success.count': 'nitro_rpc_get_nonce_success_total',

    # Database
    'l2chaindata/disk/size': 'nitro_l2chaindata_disk_bytes',
    'arbitrumdata/disk/size': 'nitro_arbitrumdata_disk_bytes',

    # System
    'system/memory/used': 'nitro_system_memory_used_bytes',
    'system/memory/held': 'nitro_system_memory_held_bytes',
    'system/cpu/goroutines': 'nitro_system_goroutines',
}

# Rate metrics (need to be tracked as counters)
RATE_METRICS = {
    'arb/block/transactions/count.count': 'nitro_blocks_with_tx_total',
    'arb/block/gasused.count': 'nitro_blocks_with_gas_total',
    'rpc/duration/all.count': 'nitro_rpc_calls_total',
}

class NitroCollector:
    """Custom collector that fetches Nitro JSON metrics"""

    def __init__(self, url):
        self.url = url
        self._metrics_cache = {}
        self._last_fetch = 0

    def fetch_metrics(self):
        """Fetch metrics from Nitro endpoint"""
        try:
            resp = requests.get(self.url, timeout=10)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"Error fetching metrics: {e}")
            return {}

    def collect(self):
        """Collect metrics for Prometheus"""
        metrics = self.fetch_metrics()

        # Key gauges
        for json_key, prom_name in KEY_METRICS.items():
            value = metrics.get(json_key, 0)
            if value is not None:
                # Handle string values (like chain/info)
                if isinstance(value, (int, float)):
                    g = GaugeMetricFamily(prom_name, f'Nitro metric: {json_key}')
                    g.add_metric([], float(value))
                    yield g

        # Rate metrics as counters
        for json_key, prom_name in RATE_METRICS.items():
            value = metrics.get(json_key, 0)
            if value is not None and isinstance(value, (int, float)):
                c = CounterMetricFamily(prom_name, f'Nitro counter: {json_key}')
                c.add_metric([], float(value))
                yield c

        # Calculate derived metrics

        # TX per second (from block creation time)
        block_creation_ns = metrics.get('arb/sequencer/block/creation.mean', 0)
        tx_per_block = metrics.get('arb/block/transactions/count.mean', 0)
        if block_creation_ns > 0 and tx_per_block > 0:
            tx_per_sec = (tx_per_block / block_creation_ns) * 1e9
            g = GaugeMetricFamily('nitro_theoretical_tps', 'Theoretical TPS based on block time and tx/block')
            g.add_metric([], tx_per_sec)
            yield g

        # Nonce cache hit rate
        nonce_hit = metrics.get('arb/sequencer/noncecache/hit', 0)
        nonce_miss = metrics.get('arb/sequencer/noncecache/miss', 0)
        if nonce_hit + nonce_miss > 0:
            hit_rate = nonce_hit / (nonce_hit + nonce_miss)
            g = GaugeMetricFamily('nitro_nonce_cache_hit_rate', 'Nonce cache hit rate')
            g.add_metric([], hit_rate)
            yield g

        # RPC success rate
        rpc_success = metrics.get('rpc/success', 0)
        rpc_failure = metrics.get('rpc/failure', 0)
        if rpc_success + rpc_failure > 0:
            success_rate = rpc_success / (rpc_success + rpc_failure)
            g = GaugeMetricFamily('nitro_rpc_success_rate', 'RPC success rate')
            g.add_metric([], success_rate)
            yield g

        # Send TX success rate
        send_success = metrics.get('rpc/duration/eth_sendRawTransaction/success.count', 0)
        send_failure = metrics.get('rpc/duration/eth_sendRawTransaction/failure.count', 0)
        if send_success + send_failure > 0:
            success_rate = send_success / (send_success + send_failure)
            g = GaugeMetricFamily('nitro_send_tx_success_rate', 'sendRawTransaction success rate')
            g.add_metric([], success_rate)
            yield g


def main():
    print(f"Starting Nitro metrics exporter")
    print(f"Fetching from: {NITRO_METRICS_URL}")

    # Register custom collector
    collector = NitroCollector(NITRO_METRICS_URL)
    REGISTRY.register(collector)

    # Start HTTP server
    start_http_server(9091)
    print("Exporter running on :9091")

    # Keep alive
    while True:
        time.sleep(60)


if __name__ == '__main__':
    main()
