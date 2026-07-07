import assert from 'node:assert/strict';
import test from 'node:test';

import { SnapshotService } from '../src/SnapshotService.js';
import type {
  BlockStateAdapter,
  EditorJSInstance,
  HistorySnapshot
} from '../src/types.js';

function createEditor(initialText: string): {
  editor: EditorJSInstance;
  setText: (text: string) => void;
} {
  let text = initialText;
  const block = {
    id: 'block-1',
  };

  const editor = {
    isReady: Promise.resolve(),
    save: async () => ({
      time: Date.now(),
      version: '2.31.6',
      blocks: [
        {
          id: 'block-1',
          type: 'paragraph',
          data: {
            text,
          },
        },
      ],
    }),
    blocks: {
      getById: (id: string) => id === 'block-1' ? block : null,
      getCurrentBlockIndex: () => -1,
      getBlockByIndex: () => undefined,
      render: async (data: HistorySnapshot['data']) => {
        text = String(data.blocks[0]?.data.text ?? '');
      },
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
    setText: (value) => {
      text = value;
    },
  };
}

test('compares document data independently of time and object key order', async () => {
  const { editor } = createEditor('hello');
  const service = new SnapshotService(editor);
  const first = await service.capture();
  const second: HistorySnapshot = {
    data: {
      time: 1,
      version: 'different',
      blocks: [
        {
          id: 'block-1',
          type: 'paragraph',
          data: {
            text: 'hello',
          },
        },
      ],
    },
  };

  assert.equal(service.equals(first, second), true);
  assert.equal(service.fingerprint(first), service.fingerprint(second));
});

test('captures and restores adapter state', async () => {
  const { editor } = createEditor('hello');
  let privateState = {
    expanded: true,
  };
  const adapter: BlockStateAdapter<typeof privateState> = {
    capture: () => privateState,
    restore: (_block, state) => {
      privateState = state;
    },
  };
  const service = new SnapshotService(editor, {
    paragraph: adapter,
  });
  const captured = await service.capture();

  privateState = {
    expanded: false,
  };

  await service.restore(captured);

  assert.deepEqual(privateState, {
    expanded: true,
  });
});
