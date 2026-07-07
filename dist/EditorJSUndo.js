import { AsyncQueue } from './AsyncQueue.js';
import { HistoryManager } from './HistoryManager.js';
import { IndexedDBHistoryStore } from './IndexedDBHistoryStore.js';
import { ShortcutController } from './ShortcutController.js';
import { SnapshotService } from './SnapshotService.js';
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MERGE_WINDOW_MS = 500;
const RANDOM_ID_RADIX = 36;
function createEntryId() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(RANDOM_ID_RADIX)}-${Math.random()
        .toString(RANDOM_ID_RADIX)
        .slice(2)}`;
}
function asError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
function readNumber(record, key) {
    const value = record[key];
    return typeof value === 'number' ? value : undefined;
}
export class EditorJSUndo {
    constructor(config) {
        this.queue = new AsyncQueue();
        this.initialized = false;
        this.destroyed = false;
        this.applyingHistory = false;
        this.runningOperation = false;
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
        if (maxBytes !== undefined
            && (!Number.isFinite(maxBytes) || maxBytes < 1)) {
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
        void this.isReady.catch((error) => this.reportError(error));
    }
    get canUndo() {
        return this.initialized
            && !this.destroyed
            && !this.runningOperation
            && !this.editor.readOnly.isEnabled
            && this.history.canUndo;
    }
    get canRedo() {
        return this.initialized
            && !this.destroyed
            && !this.runningOperation
            && !this.editor.readOnly.isEnabled
            && this.history.canRedo;
    }
    handleChange(_api, event) {
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
                const entry = {
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
    undo() {
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
                }
                finally {
                    this.applyingHistory = false;
                }
            });
        });
    }
    redo() {
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
                }
                finally {
                    this.applyingHistory = false;
                }
            });
        });
    }
    clear() {
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
    destroy() {
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
    async initialize() {
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
                this.reportError(new Error('EditorJSUndo could not resolve the editor holder; keyboard shortcuts are disabled.'));
            }
            else {
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
    async initializeStorage(currentState) {
        try {
            const factory = this.persistenceConfig?.indexedDB ?? globalThis.indexedDB;
            if (factory === undefined) {
                throw new Error('IndexedDB is not available in this environment.');
            }
            this.storage = new IndexedDBHistoryStore(factory, this.persistenceConfig?.databaseName);
            await this.storage.open();
            const persisted = await this.storage.load(this.instanceId);
            if (persisted !== undefined
                && persisted.shadowFingerprint === this.snapshots.fingerprint(currentState)
                && this.snapshots.hasSameDocument(persisted.shadowState, currentState)) {
                this.history.restore(persisted);
                this.shadowState = this.snapshots.clone(persisted.shadowState);
            }
            else {
                if (persisted !== undefined) {
                    await this.storage.clear(this.instanceId);
                }
                await this.persist();
            }
        }
        catch (error) {
            this.disableStorage(error);
        }
    }
    async persist() {
        if (this.storage === undefined) {
            return;
        }
        const shadowState = this.requireShadowState();
        try {
            await this.storage.save(this.instanceId, this.history.export(), shadowState, this.snapshots.fingerprint(shadowState), shadowState.data.version);
        }
        catch (error) {
            this.disableStorage(error);
        }
    }
    disableStorage(error) {
        this.reportError(error);
        this.storage?.close();
        this.storage = undefined;
    }
    async run(operation) {
        this.runningOperation = true;
        try {
            return await operation();
        }
        catch (error) {
            this.reportError(error);
            throw error;
        }
        finally {
            this.runningOperation = false;
        }
    }
    requireShadowState() {
        if (this.shadowState === undefined) {
            throw new Error('EditorJSUndo is not initialized.');
        }
        return this.shadowState;
    }
    resolveHolder() {
        if (typeof this.holder !== 'string') {
            if (this.holder !== undefined) {
                return this.holder;
            }
        }
        else if (typeof document !== 'undefined') {
            const byId = document.getElementById(this.holder);
            if (byId !== null) {
                return byId;
            }
            try {
                const bySelector = document.querySelector(this.holder);
                if (bySelector !== null) {
                    return bySelector;
                }
            }
            catch {
                return undefined;
            }
        }
        const firstBlock = this.editor.blocks.getBlockByIndex(0);
        return firstBlock?.holder.closest('.codex-editor')
            ?? firstBlock?.holder.parentElement
            ?? undefined;
    }
    describeEvents(event) {
        const events = Array.isArray(event) ? event : [event];
        return events.map((item) => {
            const detail = item.detail;
            const target = detail.target;
            const blockId = target !== null
                && typeof target === 'object'
                && 'id' in target
                && typeof target.id === 'string'
                ? target.id
                : '';
            return {
                type: item.type,
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
    reportError(error) {
        const normalized = asError(error);
        if (this.onError !== undefined) {
            try {
                this.onError(normalized);
            }
            catch (callbackError) {
                console.error('[EditorJSUndo] onError callback failed.', callbackError);
            }
        }
        else {
            console.error('[EditorJSUndo]', normalized);
        }
    }
}
//# sourceMappingURL=EditorJSUndo.js.map