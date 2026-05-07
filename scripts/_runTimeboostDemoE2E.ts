/**
 * Run the full Timeboost demo against whatever PARENT_CHAIN_RPC + MAIN_PRIVATE_KEY
 * are configured in .env. Bypasses the YAML scripted runner (which depends on
 * zod/js-yaml types not currently set up for type-checking).
 *
 * This is the same code path as Menu → Timeboost → "Run Full Timeboost Demo",
 * just driven from a script for easier observation.
 */

import 'dotenv/config';
import { initializeApp, initializeChainMode } from '../src/init.js';
import { ChainEnv, setNodeManagerClass } from '../src/state/chainEnv/index.js';
import { NodeManager } from '../src/core/docker/nodeManager.js';
import { OperationMode } from '../src/types/index.js';
import { runFullTimeboostDemo } from '../src/playbooks/timeboost/timeboostDemoRunner.js';

async function main(): Promise<void> {
  initializeApp();
  setNodeManagerClass(NodeManager);
  ChainEnv.getInstance().setOperationMode(OperationMode.CHAIN);
  // 'reuse' loads the existing chain when CHAIN_DEPLOYMENT_TRANSACTION_HASH is set
  // (saves ~60s + Sepolia ETH per iteration). Set TIMEBOOST_FORCE_REDEPLOY=1 to
  // force a fresh deploy from this driver script.
  await initializeChainMode({ headless: true, restorePolicy: 'reuse' });

  console.log('--- Starting Timeboost demo ---');
  const result = await runFullTimeboostDemo();
  console.log('--- Demo complete ---');
  console.log('report:', result.reportPath);
  console.log('size:', result.reportSize);
  console.log('experiments:', result.experiments.length);
  console.log('events captured:', result.events.length);
  console.log('unauthorized rejections:', result.unauthorized.filter((u) => u.recognised).length);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
