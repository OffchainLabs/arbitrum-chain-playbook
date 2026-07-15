/**
 * Unit tests for the headless script schema:
 * - every checked-in example script must validate against ScriptSchema and
 *   against the paramsSchema its playbook declares for the command
 * - malformed envelopes are rejected
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ScriptSchema } from '../../src/scripted/schema.js';
import playbookRegistry from '../../src/playbooks/index.js';

const examplesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples');
const exampleFiles = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.json'));

describe('example scripts', () => {
  assert.ok(exampleFiles.length > 0, 'examples/ should contain scripts');

  for (const file of exampleFiles) {
    test(`${file} passes envelope + params validation`, () => {
      const raw = fs.readFileSync(path.join(examplesDir, file), 'utf8');
      const doc = file.endsWith('.yaml') ? yaml.load(raw) : JSON.parse(raw);

      const parsed = ScriptSchema.safeParse(doc);
      assert.ok(parsed.success, `envelope invalid: ${!parsed.success ? parsed.error.message : ''}`);

      const script = parsed.data;
      const playbook = playbookRegistry.get(script.playbook);
      assert.ok(playbook, `unknown playbook "${script.playbook}"`);

      const spec = playbook.listHeadlessCommands?.().find((s) => s.command === script.command);
      assert.ok(spec, `playbook "${script.playbook}" does not list command "${script.command}"`);

      if (spec.paramsSchema) {
        const params = spec.paramsSchema.safeParse(script.params);
        assert.ok(params.success, `params invalid: ${!params.success ? params.error.message : ''}`);
      }
    });
  }
});

describe('envelope validation', () => {
  test('rejects a script missing required fields', () => {
    const r = ScriptSchema.safeParse({ playbook: 'timeboost' });
    assert.equal(r.success, false);
  });

  test('rejects an unknown mode', () => {
    const r = ScriptSchema.safeParse({
      mode: 'warp-drive',
      playbook: 'timeboost',
      command: 'run-full-demo',
    });
    assert.equal(r.success, false);
  });
});
