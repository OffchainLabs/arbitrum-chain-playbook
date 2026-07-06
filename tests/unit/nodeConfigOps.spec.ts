/**
 * Unit tests for node-config read/write operations:
 * - port extractors (including the no-write-side-effect regression)
 * - applyOverwriteToNodeConfig / overwriteNodeConfigFile
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractHttpPortFromConfigPath,
  extractWsPortFromConfigPath,
} from '../../src/core/docker/nodeConfigExtractors.js';
import { applyOverwriteToNodeConfig, overwriteNodeConfigFile } from '../../src/core/nodeConfig/nodeConfigOperations.js';
import type { NodeConfig } from '@arbitrum/chain-sdk';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-nodeconfig-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('port extractors', () => {
  test('reads http and ws ports', () => {
    const p = path.join(tmpDir, 'node-config.json');
    fs.writeFileSync(p, JSON.stringify({ http: { port: 8449 }, ws: { port: 8450 } }));
    assert.equal(extractHttpPortFromConfigPath(p), 8449);
    assert.equal(extractWsPortFromConfigPath(p), 8450);
  });

  test('http port is required', () => {
    const p = path.join(tmpDir, 'node-config.json');
    fs.writeFileSync(p, JSON.stringify({ http: {} }));
    assert.throws(() => extractHttpPortFromConfigPath(p), /http\.port/);
  });

  test('missing ws port defaults to 0 WITHOUT rewriting the config file', () => {
    const p = path.join(tmpDir, 'node-config.json');
    const original = JSON.stringify({ http: { port: 8449 } });
    fs.writeFileSync(p, original);
    assert.equal(extractWsPortFromConfigPath(p), 0);
    // Regression: the old implementation wrote ws.port=0 back into the file.
    assert.equal(fs.readFileSync(p, 'utf8'), original);
  });
});

describe('node-config overwrites', () => {
  const baseConfig = () =>
    ({
      node: {},
      http: { port: 8449 },
    }) as unknown as NodeConfig;

  test('fast-validator sets bold intervals', () => {
    const out = applyOverwriteToNodeConfig(baseConfig(), 'fast-validator') as any;
    assert.equal(out.node.bold['assertion-posting-interval'], '10s');
    assert.equal(out.node.bold['assertion-confirming-interval'], '10s');
  });

  test('unknown option returns config unchanged', () => {
    const cfg = baseConfig();
    const out = applyOverwriteToNodeConfig(cfg, 'nonsense' as never);
    assert.deepEqual(out, cfg);
  });

  test('overwriteNodeConfigFile applies the overwrite in place', async () => {
    const p = path.join(tmpDir, 'node-config.json');
    fs.writeFileSync(p, JSON.stringify({ node: {}, http: { port: 8449 } }));
    await overwriteNodeConfigFile('fast-batch-poster', p);
    const after = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.ok(after.node['batch-poster'], 'batch-poster block should be present');
  });

  test('overwriteNodeConfigFile throws for missing file', async () => {
    await assert.rejects(() => overwriteNodeConfigFile('fast-validator', path.join(tmpDir, 'nope.json')), /not found/);
  });
});
