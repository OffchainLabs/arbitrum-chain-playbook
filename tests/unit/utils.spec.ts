/**
 * Unit tests for small utils: bytes32 normalization, cancellable sleep,
 * and the LOG_LEVEL gating of logger.debug's console output.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBytes32Like } from '../../src/utils/bytes32.js';
import { cancellableSleep, CancellationError } from '../../src/utils/cancellation.js';
import { filenameGlobToRegExp } from '../../src/utils/nodeConfigUtils.js';
import logger from '../../src/utils/logger.js';

describe('normalizeBytes32Like', () => {
  const canonical = `0x${'0'.repeat(63)}1`;

  test('bigint', () => {
    assert.equal(normalizeBytes32Like(1n), canonical);
  });

  test('unpadded mixed-case hex string', () => {
    assert.equal(normalizeBytes32Like('0x1'), canonical);
    assert.equal(normalizeBytes32Like(`0x${'A'.repeat(64)}`), `0x${'a'.repeat(64)}`);
  });

  test('decimal string', () => {
    assert.equal(normalizeBytes32Like('1'), canonical);
  });

  test('equivalent representations normalize identically', () => {
    const asBigint = normalizeBytes32Like(255n);
    const asHex = normalizeBytes32Like('0xFF');
    const asDecimal = normalizeBytes32Like('255');
    assert.equal(asBigint, asHex);
    assert.equal(asHex, asDecimal);
  });
});

describe('cancellableSleep', () => {
  test('resolves after the delay', async () => {
    const start = Date.now();
    await cancellableSleep(20);
    assert.ok(Date.now() - start >= 15);
  });

  test('rejects with CancellationError when aborted mid-sleep', async () => {
    const ac = new AbortController();
    const p = cancellableSleep(5_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p, CancellationError);
  });

  test('rejects immediately on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(cancellableSleep(1_000, ac.signal), CancellationError);
  });
});

describe('logger.debug LOG_LEVEL gating', () => {
  const originalLevel = process.env.LOG_LEVEL;
  const originalDebug = console.debug;

  afterEach(() => {
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    console.debug = originalDebug;
  });

  test('silent on console unless LOG_LEVEL=debug', () => {
    let calls = 0;
    console.debug = () => {
      calls++;
    };

    delete process.env.LOG_LEVEL;
    logger.debug('hidden');
    assert.equal(calls, 0);

    process.env.LOG_LEVEL = 'debug';
    logger.debug('visible');
    assert.equal(calls, 1);
  });
});

describe('filenameGlobToRegExp', () => {
  test('regex metacharacters in the pattern are treated literally', () => {
    const re = filenameGlobToRegExp('node+config(1)-*.json');
    assert.ok(re.test('node+config(1)-x.json'));
    assert.ok(!re.test('nodeconfig1-x.json'));
  });
});
