import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('standalone bundle has no imports and exposes a global class', () => {
  const bundle = readFileSync(
    resolve(process.cwd(), 'dist/editorjs-undo.js'),
    'utf8'
  );
  const context: Record<string, unknown> = {};

  assert.doesNotMatch(bundle, /^\s*import\s/m);
  runInNewContext(bundle, context);
  assert.equal(typeof context.EditorJSUndo, 'function');
});
