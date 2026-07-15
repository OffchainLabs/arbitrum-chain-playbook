/**
 * Unit tests for chain-state persistence:
 * - loadChainDataFromDisk from a realistic node-config.json
 * - core-contracts save/load round-trip (restart without tx hash keeps them)
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadChainDataFromDisk,
  saveCoreContracts,
  loadCoreContracts,
  nodeConfigFileExists,
} from '../../src/state/chainEnv/persistence.js';
import type { CoreContracts } from '@arbitrum/chain-sdk';

const CHAIN_ID = 412346;

const sampleCoreContracts = {
  rollup: '0xaa6561aE5515768a5299569CDc159B1B3E98141b',
  nativeToken: '0x0000000000000000000000000000000000000000',
  inbox: '0xDbd8f2c51c3c77899d4f8A29879D7747aD5c8460',
  outbox: '0x1111111111111111111111111111111111111111',
  rollupEventInbox: '0x2222222222222222222222222222222222222222',
  challengeManager: '0x3333333333333333333333333333333333333333',
  adminProxy: '0x4444444444444444444444444444444444444444',
  sequencerInbox: '0x9307e7F8260Ecf22f25e9BD4f6BaE6c580f67606',
  bridge: '0x7D65930f011870d1330f4B04834Fd937F8Ae5cF1',
  upgradeExecutor: '0x5555555555555555555555555555555555555555',
  validatorWalletCreator: '0x2c37dCBCE3fbe32c9Ba62892F1E41DbB023BB62b',
  deployedAtBlockNumber: 279984713,
} as CoreContracts;

function writeNodeConfig(dir: string): void {
  const infoJson = JSON.stringify([
    {
      'chain-id': CHAIN_ID,
      'chain-name': 'test-chain',
      'chain-config': { chainId: CHAIN_ID, arbitrum: { InitialChainOwner: '0x0' } },
    },
  ]);
  const nodeConfig = {
    chain: { 'info-json': infoJson, name: 'test-chain' },
    http: { port: 8449 },
  };
  fs.writeFileSync(path.join(dir, 'node-config.json'), JSON.stringify(nodeConfig, null, 2));
}

describe('persistence', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-persist-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nodeConfigFileExists is false in an empty dir', () => {
    assert.equal(nodeConfigFileExists(), false);
  });

  test('loadChainDataFromDisk extracts chainConfig from chain.info-json', () => {
    writeNodeConfig(tmpDir);
    const data = loadChainDataFromDisk();
    assert.ok(data, 'chain data should load');
    assert.equal(data.chainConfig.chainId, CHAIN_ID);
    assert.ok(data.nodeConfigPaths.size >= 1);
    assert.equal(data.coreContracts, undefined, 'no core contracts persisted yet');
  });

  test('core contracts survive a save/load round-trip', () => {
    saveCoreContracts(CHAIN_ID, sampleCoreContracts);
    const loaded = loadCoreContracts(CHAIN_ID);
    assert.deepEqual(loaded, sampleCoreContracts);
  });

  test('loadChainDataFromDisk picks up persisted core contracts', () => {
    writeNodeConfig(tmpDir);
    saveCoreContracts(CHAIN_ID, sampleCoreContracts);
    const data = loadChainDataFromDisk();
    assert.ok(data);
    assert.deepEqual(data.coreContracts, sampleCoreContracts);
  });

  test('loadCoreContracts returns null when absent', () => {
    assert.equal(loadCoreContracts(999999), null);
  });
});
