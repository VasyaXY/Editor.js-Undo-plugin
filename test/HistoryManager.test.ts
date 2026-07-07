import assert from 'node:assert/strict';
import test from 'node:test';

import { HistoryManager } from '../src/HistoryManager.js';
import type { HistoryEntry, HistorySnapshot } from '../src/types.js';

function snapshot(text: string): HistorySnapshot {
  return {
    data: {
      blocks: [
        {
          id: 'block-1',
          type: 'paragraph',
          data: {
            text,
          },
        },
      ],
    },
  };
}

function entry(
  id: string,
  before: string,
  after: string,
  createdAt: number,
  type: HistoryEntry['events'][number]['type'] = 'block-changed'
): HistoryEntry {
  return {
    id,
    createdAt,
    events: [
      {
        type,
        blockId: 'block-1',
      },
    ],
    before: snapshot(before),
    after: snapshot(after),
  };
}

test('merges adjacent changes to the same block', () => {
  const history = new HistoryManager({
    maxEntries: 10,
    mergeWindowMs: 500,
  });

  history.push(entry('first', '', 'a', 1_000));
  history.push(entry('second', 'a', 'ab', 1_300));

  const state = history.export();

  assert.equal(state.undoStack.length, 1);
  assert.deepEqual(state.undoStack[0]?.before, snapshot(''));
  assert.deepEqual(state.undoStack[0]?.after, snapshot('ab'));
});

test('does not merge structural changes', () => {
  const history = new HistoryManager({
    maxEntries: 10,
    mergeWindowMs: 500,
  });

  history.push(entry('first', '', 'a', 1_000));
  history.push(entry('second', 'a', 'ab', 1_100, 'block-added'));

  assert.equal(history.export().undoStack.length, 2);
});

test('moves entries between undo and redo stacks', () => {
  const history = new HistoryManager({
    maxEntries: 10,
    mergeWindowMs: 0,
  });
  const historyEntry = entry('first', '', 'a', 1_000);

  history.push(historyEntry);
  history.commitUndo(historyEntry.id);

  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);

  history.commitRedo(historyEntry.id);

  assert.equal(history.canUndo, true);
  assert.equal(history.canRedo, false);
});

test('clears redo after a new change and applies maxEntries', () => {
  const history = new HistoryManager({
    maxEntries: 2,
    mergeWindowMs: 0,
  });

  history.push(entry('first', '', 'a', 1_000));
  history.push(entry('second', 'a', 'ab', 2_000));
  history.commitUndo('second');
  history.push(entry('third', 'a', 'x', 3_000));
  history.push(entry('fourth', 'x', 'xy', 4_000));

  const state = history.export();

  assert.deepEqual(state.undoStack.map(({ id }) => id), ['third', 'fourth']);
  assert.equal(state.redoStack.length, 0);
});
