/**
 * Unit tests for runnerKit.wipeLocalChainData.
 *
 * Locks the invariant that the wipe spares core-contracts.json (persisted
 * chain metadata) while removing node DB state. The same exemption is relied
 * on by malicious-validator's validateChainIsClean — a regression here would
 * silently delete persisted core contracts on the next restart.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { wipeLocalChainData } from '../../src/playbooks/runnerKit.js';
import { LOCAL_DATA_DIR } from '../../src/types/constants.js';

const CHAIN_ID = 777777777;

describe('wipeLocalChainData', () => {
  let tmpDir: string;
  let originalCwd: string;
  let chainDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-wipe-'));
    process.chdir(tmpDir);
    chainDir = path.join(tmpDir, LOCAL_DATA_DIR, String(CHAIN_ID));
    fs.mkdirSync(chainDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes node DB state but spares core-contracts.json', () => {
    fs.writeFileSync(path.join(chainDir, 'core-contracts.json'), '{"rollup":"0x0"}');
    fs.mkdirSync(path.join(chainDir, 'nitro'), { recursive: true });
    fs.writeFileSync(path.join(chainDir, 'nitro', 'CURRENT'), 'db');
    fs.writeFileSync(path.join(chainDir, 'node.log'), 'log');

    wipeLocalChainData(CHAIN_ID);

    assert.ok(fs.existsSync(path.join(chainDir, 'core-contracts.json')), 'core-contracts.json must survive');
    assert.ok(!fs.existsSync(path.join(chainDir, 'nitro')), 'db dir should be gone');
    assert.ok(!fs.existsSync(path.join(chainDir, 'node.log')), 'log should be gone');
  });

  test('a dir holding only core-contracts.json is left untouched', () => {
    fs.writeFileSync(path.join(chainDir, 'core-contracts.json'), '{"rollup":"0x0"}');
    wipeLocalChainData(CHAIN_ID);
    assert.deepEqual(fs.readdirSync(chainDir), ['core-contracts.json']);
  });

  test('is a no-op when the chain dir does not exist', () => {
    fs.rmSync(chainDir, { recursive: true, force: true });
    assert.doesNotThrow(() => wipeLocalChainData(CHAIN_ID));
  });
});
