import type { API, BlockAPI, BlockMutationEvent, BlockMutationType, OutputData } from '@editorjs/editorjs';
export interface MutationDescriptor {
    type: BlockMutationType;
    blockId: string;
    index?: number;
    fromIndex?: number;
    toIndex?: number;
}
export interface BlockStateAdapter<State = unknown> {
    capture(block: BlockAPI): State | Promise<State>;
    restore(block: BlockAPI, state: State): void | Promise<void>;
}
export interface CapturedBlockState {
    tool: string;
    state: unknown;
}
export interface HistorySnapshot {
    data: OutputData;
    blockStates?: Record<string, CapturedBlockState>;
    focusedBlockId?: string;
}
export interface HistoryEntry {
    id: string;
    createdAt: number;
    events: MutationDescriptor[];
    before: HistorySnapshot;
    after: HistorySnapshot;
}
export interface HistoryState {
    undoStack: HistoryEntry[];
    redoStack: HistoryEntry[];
}
export interface PersistedHistory extends HistoryState {
    shadowState: HistorySnapshot;
    shadowFingerprint: string;
}
export interface IndexedDBPersistenceConfig {
    indexedDB?: IDBFactory;
    databaseName?: string;
    maxBytes?: number;
}
export interface EditorJSInstance {
    isReady: Promise<void>;
    blocks: API['blocks'];
    caret: API['caret'];
    readOnly: API['readOnly'];
    save(): Promise<OutputData>;
}
export interface EditorJSUndoConfig {
    editor: EditorJSInstance;
    instanceId: string;
    holder?: HTMLElement | string;
    maxEntries?: number;
    mergeWindowMs?: number;
    persistence?: false | IndexedDBPersistenceConfig;
    shortcuts?: boolean;
    stateAdapters?: Record<string, BlockStateAdapter>;
    onError?: (error: Error) => void;
}
export type EditorChangeHandler = (api: API, event: BlockMutationEvent | BlockMutationEvent[]) => void | Promise<void>;
//# sourceMappingURL=types.d.ts.map