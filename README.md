# Editor.js Undo

Undo/redo controller for Editor.js. It stores complete Editor.js snapshots, so
text changes and structural operations such as block insertion, deletion,
movement, conversion and tune changes are restored consistently.

## Script Tag

The standalone build is a single file with no imports. Load it after Editor.js:

```html
<script src="./editorjs.umd.js"></script>
<script src="./editorjs-undo.js"></script>

<div id="editor"></div>

<script>
  let undo;

  const editor = new EditorJS({
    holder: 'editor',
    onChange: function (api, event) {
      if (undo) {
        undo.handleChange(api, event);
      }
    },
  });

  undo = new EditorJSUndo({
    editor: editor,
    instanceId: 'article-42',
    holder: 'editor',
    persistence: {},
  });
</script>
```

Build the standalone file with:

```shell
npm run build:standalone
```

The result is `dist/editorjs-undo.js`. It exposes the class as
`window.EditorJSUndo`.

## Usage

```ts
import EditorJS from '@editorjs/editorjs';
import { EditorJSUndo } from '@editorjs/undo';

let undo: EditorJSUndo | undefined;

const editor = new EditorJS({
  holder: 'editor',
  onChange: (api, event) => {
    void undo?.handleChange(api, event);
  },
});

undo = new EditorJSUndo({
  editor,
  instanceId: 'article-42',
  holder: 'editor',
  persistence: {},
});

await undo.isReady;
```

Editor.js exposes one `onChange` callback. If the application already uses it,
call both handlers:

```ts
onChange: (api, event) => {
  void undo?.handleChange(api, event);
  applicationOnChange(api, event);
},
```

Each call to `handleChange` represents one Editor.js mutation batch.

## API

```ts
await undo.undo();
await undo.redo();
await undo.clear();

undo.canUndo;
undo.canRedo;

undo.destroy();
```

`undo()` and `redo()` return `false` when the corresponding stack is empty or the
editor is read-only.

Keyboard shortcuts are enabled by default:

- `Ctrl+Z` or `Meta+Z`: undo;
- `Ctrl+Shift+Z` or `Meta+Shift+Z`: redo.

The listener is attached to the configured editor holder. Pass `shortcuts: false`
to disable it.

## IndexedDB

Persistence is opt-in. Pass `persistence: {}` to use the `editorjs-undo`
database, or configure it:

```ts
const undo = new EditorJSUndo({
  editor,
  instanceId: 'article-42',
  persistence: {
    databaseName: 'my-editor-history',
    maxBytes: 10 * 1024 * 1024,
  },
});
```

Each editor must have a stable, unique `instanceId`. Metadata and history entries
are committed atomically. If IndexedDB is unavailable, blocked, over quota or
changed concurrently in another tab, the controller reports the error through
`onError` and continues with in-memory history.

Persisted history is restored only when the editor's current blocks match the
last persisted snapshot. A mismatch clears stale history instead of applying it
to a different document revision.

IndexedDB history is not a document backup. Browsers may evict it, and sensitive
document content should not be persisted without an application-level privacy
decision.

## Tool State

Editor.js can restore only state returned by a Tool's `save()` method. For
JSON-compatible runtime state that is not included in `save()`, register an
adapter by Tool name:

```ts
const diagramStateStore = new Map<string, unknown>();

const undo = new EditorJSUndo({
  editor,
  instanceId: 'article-42',
  stateAdapters: {
    diagram: {
      capture: (block) => diagramStateStore.get(block.id) ?? null,
      restore: (block, state) => {
        diagramStateStore.set(block.id, state);
        block.call('importUndoState', { state });
      },
    },
  },
});
```

Adapters must not store DOM nodes, functions, pending requests or other
non-JSON-compatible values.
