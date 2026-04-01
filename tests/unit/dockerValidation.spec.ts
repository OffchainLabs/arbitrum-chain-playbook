import test from 'node:test';
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Use explicit ".js" extension to satisfy NodeNext/ESM import rules under ts-node.
import { validateRollupAndLocalDbClean } from '../../src/core/docker/validation.js';

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mvpb-validation-'));

test('validateRollupAndLocalDbClean: returns true when batchCount <= 1 and local db is clean', async () => {
  const tmp = makeTmpDir();
  try {
    const chainId = 12345;
    const sequencerInbox = '0x00000000000000000000000000000000000000aa' as const;

    const parentClient = {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'sequencerInbox') return sequencerInbox;
        if (functionName === 'batchCount') return 1n;
        throw new Error(`unexpected function: ${String(functionName)}`);
      },
    } as any;

    const ok = await validateRollupAndLocalDbClean({
      parentClient,
      sequencerInboxAddress: sequencerInbox,
      chainId,
      cwd: tmp,
    });

    expect(ok).to.equal(true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateRollupAndLocalDbClean: returns false when batchCount > 1', async () => {
  const tmp = makeTmpDir();
  try {
    const chainId = 12345;
    const sequencerInbox = '0x00000000000000000000000000000000000000aa' as const;

    const parentClient = {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'sequencerInbox') return sequencerInbox;
        if (functionName === 'batchCount') return 2n; // > 1 => non-genesis activity
        throw new Error(`unexpected function: ${String(functionName)}`);
      },
    } as any;

    const ok = await validateRollupAndLocalDbClean({
      parentClient,
      sequencerInboxAddress: sequencerInbox,
      chainId,
      cwd: tmp,
    });

    expect(ok).to.equal(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateRollupAndLocalDbClean: returns false when local db contains leftover files', async () => {
  const tmp = makeTmpDir();
  try {
    const chainId = 999;
    const sequencerInbox = '0x00000000000000000000000000000000000000aa' as const;

    // Create a leftover file under <cwd>/.arbitrum/<chainId>/main/
    const leftoverDir = path.join(tmp, '.arbitrum', String(chainId), 'main');
    fs.mkdirSync(leftoverDir, { recursive: true });
    fs.writeFileSync(path.join(leftoverDir, 'dummy.db'), 'x');

    const parentClient = {
      readContract: async ({ functionName }: any) => {
        if (functionName === 'sequencerInbox') return sequencerInbox;
        if (functionName === 'batchCount') return 1n;
        throw new Error(`unexpected function: ${String(functionName)}`);
      },
    } as any;

    const ok = await validateRollupAndLocalDbClean({
      parentClient,
      sequencerInboxAddress: sequencerInbox,
      chainId,
      cwd: tmp,
    });

    expect(ok).to.equal(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
