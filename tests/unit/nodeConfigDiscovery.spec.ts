/**
 * Unit tests for node-config discovery (utils/nodeConfigUtils.ts).
 *
 * Regression coverage for the glob→regex conversion bug where
 * 'node-config-*.json' was compiled to /node-config-\.*\.json/ (escaping
 * the dot AFTER substituting '*'), which could never match
 * node-config-malicious.json / node-config-honest.json.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverNodeConfigs, filenameGlobToRegExp } from '../../src/utils/nodeConfigUtils.js';

describe('filenameGlobToRegExp', () => {
  test('matches star patterns against real config names', () => {
    const re = filenameGlobToRegExp('node-config-*.json');
    assert.ok(re.test('node-config-malicious.json'));
    assert.ok(re.test('node-config-honest.json'));
  });

  test('does not treat the dot as a wildcard', () => {
    const re = filenameGlobToRegExp('node-config-*.json');
    assert.ok(!re.test('node-config-maliciousXjson'));
  });

  test('is anchored at both ends', () => {
    const re = filenameGlobToRegExp('node-config-*.json');
    assert.ok(!re.test('xnode-config-a.json'));
    assert.ok(!re.test('node-config-a.json.bak'));
  });
});

describe('discoverNodeConfigs', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-discovery-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds the default node-config.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'node-config.json'), '{}');
    const configs = discoverNodeConfigs();
    assert.ok(configs.has('node-config'));
  });

  test('finds malicious/honest variants via node-config-*.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'node-config-malicious.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'node-config-honest.json'), '{}');
    const configs = discoverNodeConfigs();
    assert.ok(configs.has('node-config-malicious'), 'malicious config should be discovered');
    assert.ok(configs.has('node-config-honest'), 'honest config should be discovered');
  });

  test('finds configs under configs/node-*.json', () => {
    fs.mkdirSync(path.join(tmpDir, 'configs'));
    fs.writeFileSync(path.join(tmpDir, 'configs', 'node-extra.json'), '{}');
    const configs = discoverNodeConfigs();
    assert.ok(configs.has('node-extra'));
  });

  test('ignores non-matching files', () => {
    fs.writeFileSync(path.join(tmpDir, 'node-configXjson'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'other.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'node-config-a.json.bak'), '{}');
    const configs = discoverNodeConfigs();
    assert.equal(configs.size, 0);
  });
});
