import type {
  API,
  BlockMutationEvent,
  BlockMutationType
} from '@editorjs/editorjs';

import { AsyncQueue } from './AsyncQueue.js';
import { HistoryManager } from './HistoryManager.js';
import { IndexedDBHistoryStore } from './IndexedDBHistoryStore.js';
import { ShortcutController } from './ShortcutController.js';
import { SnapshotService } from './SnapshotService.js';
import type {
  EditorJSUndoConfig,
  HistoryEntry,
  MutationDescriptor
} from './types.js';

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MERGE_WINDOW_MS = 500;
const RANDOM_ID_RADIX = 36;

function createEntryId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(RANDOM_ID_RADIX)}-${Math.random()
    .toString(RANDOM_ID_RADIX)
    .slice(2)}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === 'number' ? value : undefined;
}

export class EditorJSUndo {
  public readonly isReady: Promise<void>;

  private readonly editor: EditorJSUndoConfig['editor'];
  private readonly instanceId: string;
  private readonly queue = new AsyncQueue();
  private readonly history: HistoryManager;
  private readonly snapshots: SnapshotService;
  private readonly onError?: (error: Error) => void;
  private readonly persistenceConfig?: Exclude<EditorJSUndoConfig['persistence'], false>;
  private readonly shortcutsEnabled: boolean;
  private readonly holder?: HTMLElement | string;
  private storage?: IndexedDBHistoryStore;
  private shortcuts?: ShortcutController;
  private shadowState?: Awaited<ReturnType<SnapshotService['capture']>>;
  private initialized = false;
  private destroyed = false;
  private applyingHistory = false;
  private runningOperation = false;

  constructor(config: EditorJSUndoConfig) {
    if (config.instanceId.trim() === '') {
      throw new Error('EditorJSUndo requires a non-empty instanceId.');
    }

    const maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const mergeWindowMs = config.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;

    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer.');
    }

    if (!Number.isFinite(mergeWindowMs) || mergeWindowMs < 0) {
      throw new Error('mergeWindowMs must be a non-negative number.');
    }

    const persistenceConfig = config.persistence === false
      ? undefined
      : config.persistence;
    const maxBytes = persistenceConfig?.maxBytes;

    if (
      maxBytes !== undefined
      && (!Number.isFinite(maxBytes) || maxBytes < 1)
    ) {
      throw new Error('persistence.maxBytes must be a positive number.');
    }

    this.editor = config.editor;
    this.instanceId = config.instanceId;
    this.onError = config.onError;
    this.persistenceConfig = persistenceConfig;
    this.shortcutsEnabled = config.shortcuts ?? true;
    this.holder = config.holder;
    this.history = new HistoryManager({
      maxEntries,
      mergeWindowMs,
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });
    this.snapshots = new SnapshotService(config.editor, config.stateAdapters);
    this.isReady = this.queue.enqueue(() => this.initialize());
    void this.isReady.catch((error: unknown) => this.reportError(error));
  }

  public get canUndo(): boolean {
    return this.initialized
      && !this.destroyed
      && !this.runningOperation
      && !this.editor.readOnly.isEnabled
      && this.history.canUndo;
  }

  public get canRedo(): boolean {
    return this.initialized
      && !this.destroyed
      && !this.runningOperation
      && !this.editor.readOnly.isEnabled
      && this.history.canRedo;
  }

  public handleChange(
    _api: API,
    event: BlockMutationEvent | BlockMutationEvent[]
  ): Promise<void> {
    const events = this.describeEvents(event);

    const operation = this.queue.enqueue(async () => {
      await this.isReady;

      if (this.destroyed || this.applyingHistory) {
        return;
      }

      await this.run(async () => {
        const after = await this.snapshots.capture();
        const before = this.requireShadowState();

        if (this.snapshots.equals(before, after)) {
          this.shadowState = after;

          return;
        }

        const entry: HistoryEntry = {
          id: createEntryId(),
          createdAt: Date.now(),
          events,
          before: this.snapshots.clone(before),
          after: this.snapshots.clone(after),
        };

        this.history.push(entry);
        this.shadowState = after;
        await this.persist();
      });
    });

    // Editor.js does not await onChange callbacks, so report and absorb failures here.
    return operation.catch(() => undefined);
  }

  public undo(): Promise<boolean> {
    return this.queue.enqueue(async () => {
      await this.isReady;

      if (this.destroyed || this.editor.readOnly.isEnabled) {
        return false;
      }

      const entry = this.history.peekUndo();

      if (entry === undefined) {
        return false;
      }

      return this.run(async () => {
        this.applyingHistory = true;

        try {
          await this.snapshots.restore(entry.before);
          this.history.commitUndo(entry.id);
          this.shadowState = this.snapshots.clone(entry.before);
          await this.persist();

          return true;
        } finally {
          this.applyingHistory = false;
        }
      });
    });
  }

  public redo(): Promise<boolean> {
    return this.queue.enqueue(async () => {
      await this.isReady;

      if (this.destroyed || this.editor.readOnly.isEnabled) {
        return false;
      }

      const entry = this.history.peekRedo();

      if (entry === undefined) {
        return false;
      }

      return this.run(async () => {
        this.applyingHistory = true;

        try {
          await this.snapshots.restore(entry.after);
          this.history.commitRedo(entry.id);
          this.shadowState = this.snapshots.clone(entry.after);
          await this.persist();

          return true;
        } finally {
          this.applyingHistory = false;
        }
      });
    });
  }

  public clear(): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.isReady;

      if (this.destroyed) {
        return;
      }

      await this.run(async () => {
        this.history.clear();
        this.shadowState = await this.snapshots.capture();
        await this.persist();
      });
    });
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.shortcuts?.destroy();
    this.shortcuts = undefined;

    void this.queue.enqueue(() => {
      this.storage?.close();
      this.storage = undefined;
    });
  }

  private async initialize(): Promise<void> {
    await this.editor.isReady;

    if (this.destroyed) {
      return;
    }

    const currentState = await this.snapshots.capture();

    this.shadowState = currentState;

    if (this.persistenceConfig !== undefined) {
      await this.initializeStorage(currentState);
    }

    if (this.shortcutsEnabled) {
      const holder = this.resolveHolder();

      if (holder === undefined) {
        this.reportError(new Error(
          'EditorJSUndo could not resolve the editor holder; keyboard shortcuts are disabled.'
        ));
      } else {
        this.shortcuts = new ShortcutController({
          holder,
          canUndo: () => this.canUndo,
          canRedo: () => this.canRedo,
          undo: () => this.undo(),
          redo: () => this.redo(),
          onError: (error) => this.reportError(error),
        });
      }
    }

    this.initialized = true;
  }

  private async initializeStorage(currentState: Awaited<ReturnType<SnapshotService['capture']>>): Promise<void> {
    try {
      const factory = this.persistenceConfig?.indexedDB ?? globalThis.indexedDB;

      if (factory === undefined) {
        throw new Error('IndexedDB is not available in this environment.');
      }

      this.storage = new IndexedDBHistoryStore(
        factory,
        this.persistenceConfig?.databaseName
      );

      await this.storage.open();

      const persisted = await this.storage.load(this.instanceId);

      if (
        persisted !== undefined
        && persisted.shadowFingerprint === this.snapshots.fingerprint(currentState)
        && this.snapshots.hasSameDocument(persisted.shadowState, currentState)
      ) {
        this.history.restore(persisted);
        this.shadowState = this.snapshots.clone(persisted.shadowState);
      } else {
        if (persisted !== undefined) {
          await this.storage.clear(this.instanceId);
        }

        await this.persist();
      }
    } catch (error) {
      this.disableStorage(error);
    }
  }

  private async persist(): Promise<void> {
    if (this.storage === undefined) {
      return;
    }

    const shadowState = this.requireShadowState();

    try {
      await this.storage.save(
        this.instanceId,
        this.history.export(),
        shadowState,
        this.snapshots.fingerprint(shadowState),
        shadowState.data.version
      );
    } catch (error) {
      this.disableStorage(error);
    }
  }

  private disableStorage(error: unknown): void {
    this.reportError(error);
    this.storage?.close();
    this.storage = undefined;
  }

  private async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.runningOperation = true;

    try {
      return await operation();
    } catch (error) {
      this.reportError(error);
      throw error;
    } finally {
      this.runningOperation = false;
    }
  }

  private requireShadowState(): NonNullable<EditorJSUndo['shadowState']> {
    if (this.shadowState === undefined) {
      throw new Error('EditorJSUndo is not initialized.');
    }

    return this.shadowState;
  }

  private resolveHolder(): HTMLElement | undefined {
    if (typeof this.holder !== 'string') {
      if (this.holder !== undefined) {
        return this.holder;
      }
    } else if (typeof document !== 'undefined') {
      const byId = document.getElementById(this.holder);

      if (byId !== null) {
        return byId;
      }

      try {
        const bySelector = document.querySelector<HTMLElement>(this.holder);

        if (bySelector !== null) {
          return bySelector;
        }
      } catch {
        return undefined;
      }
    }

    const firstBlock = this.editor.blocks.getBlockByIndex(0);

    return firstBlock?.holder.closest('.codex-editor') as HTMLElement | null
      ?? firstBlock?.holder.parentElement
      ?? undefined;
  }

  private describeEvents(
    event: BlockMutationEvent | BlockMutationEvent[]
  ): MutationDescriptor[] {
    const events = Array.isArray(event) ? event : [ event ];

    return events.map((item) => {
      const detail = item.detail as unknown as Record<string, unknown>;
      const target = detail.target;
      const blockId = target !== null
        && typeof target === 'object'
        && 'id' in target
        && typeof target.id === 'string'
        ? target.id
        : '';

      return {
        type: item.type as BlockMutationType,
        blockId,
        ...(readNumber(detail, 'index') !== undefined
          ? { index: readNumber(detail, 'index') }
          : {}),
        ...(readNumber(detail, 'fromIndex') !== undefined
          ? { fromIndex: readNumber(detail, 'fromIndex') }
          : {}),
        ...(readNumber(detail, 'toIndex') !== undefined
          ? { toIndex: readNumber(detail, 'toIndex') }
          : {}),
      };
    });
  }

  private reportError(error: unknown): void {
    const normalized = asError(error);

    if (this.onError !== undefined) {
      try {
        this.onError(normalized);
      } catch (callbackError) {
        console.error('[EditorJSUndo] onError callback failed.', callbackError);
      }
    } else {
      console.error('[EditorJSUndo]', normalized);
    }
  }
}
