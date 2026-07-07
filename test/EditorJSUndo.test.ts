import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  API,
  BlockMutationEvent,
  OutputData
} from '@editorjs/editorjs';

import { EditorJSUndo } from '../src/EditorJSUndo.js';
import { cloneValue } from '../src/SnapshotService.js';
import type { EditorJSInstance } from '../src/types.js';

function createEditor(initial: OutputData): {
  editor: EditorJSInstance;
  getData: () => OutputData;
  setData: (data: OutputData) => void;
} {
  let data = cloneValue(initial);

  const editor = {
    isReady: Promise.resolve(),
    save: async () => cloneValue(data),
    blocks: {
      render: async (next: OutputData) => {
        data = cloneValue(next);
      },
      getById: () => null,
      getCurrentBlockIndex: () => -1,
      getBlockByIndex: () => undefined,
    },
    caret: {
      setToBlock: () => true,
    },
    readOnly: {
      isEnabled: false,
    },
  } as unknown as EditorJSInstance;

  return {
    editor,
    getData: () => cloneValue(data),
    setData: (next) => {
      data = cloneValue(next);
    },
  };
}

function paragraph(text: string): OutputData {
  return {
    blocks: [
      {
        id: 'block-1',
        type: 'paragraph',
        data: {
          text,
        },
      },
    ],
  };
}

function changeEvent(): BlockMutationEvent {
  return {
    type: 'block-changed',
    detail: {
      target: {
        id: 'block-1',
      },
      index: 0,
    },
  } as unknown as BlockMutationEvent;
}

test('captures a change and performs undo and redo', async () => {
  const fixture = createEditor(paragraph('before'));
  const history = new EditorJSUndo({
    editor: fixture.editor,
    instanceId: 'test-editor',
    persistence: false,
    shortcuts: false,
  });

  await history.isReady;

  fixture.setData(paragraph('after'));
  await history.handleChange({} as API, changeEvent());

  assert.equal(history.canUndo, true);
  assert.equal(await history.undo(), true);
  assert.deepEqual(fixture.getData(), paragraph('before'));
  assert.equal(history.canRedo, true);

  assert.equal(await history.redo(), true);
  assert.deepEqual(fixture.getData(), paragraph('after'));

  history.destroy();
});

test('restores a deleted block with its id, type, data, tunes and position', async () => {
  const before: OutputData = {
    blocks: [
      {
        id: 'first',
        type: 'paragraph',
        data: {
          text: 'first',
        },
      },
      {
        id: 'deleted',
        type: 'header',
        data: {
          text: 'restored',
          level: 2,
        },
        tunes: {
          stretched: {
            value: true,
          },
        },
      },
      {
        id: 'last',
        type: 'paragraph',
        data: {
          text: 'last',
        },
      },
    ],
  };
  const fixture = createEditor(before);
  const history = new EditorJSUndo({
    editor: fixture.editor,
    instanceId: 'delete-test',
    persistence: false,
    shortcuts: false,
  });

  await history.isReady;
  fixture.setData({
    blocks: [before.blocks[0]!, before.blocks[2]!],
  });

  await history.handleChange({} as API, {
    type: 'block-removed',
    detail: {
      target: {
        id: 'deleted',
      },
      index: 1,
    },
  } as unknown as BlockMutationEvent);

  await history.undo();

  assert.deepEqual(fixture.getData(), before);
  history.destroy();
});

test('does not change history when the serialized state is unchanged', async () => {
  const fixture = createEditor(paragraph('same'));
  const history = new EditorJSUndo({
    editor: fixture.editor,
    instanceId: 'no-op-test',
    persistence: false,
    shortcuts: false,
  });

  await history.isReady;
  await history.handleChange({} as API, changeEvent());

  assert.equal(history.canUndo, false);
  assert.equal(await history.undo(), false);
  history.destroy();
});
