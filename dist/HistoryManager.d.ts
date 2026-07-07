import type { HistoryEntry, HistoryState } from './types.js';
export interface HistoryManagerConfig {
    maxEntries: number;
    mergeWindowMs: number;
    maxBytes?: number;
}
export declare class HistoryManager {
    private readonly config;
    private undoStack;
    private redoStack;
    constructor(config: HistoryManagerConfig);
    get canUndo(): boolean;
    get canRedo(): boolean;
    push(entry: HistoryEntry): void;
    peekUndo(): HistoryEntry | undefined;
    peekRedo(): HistoryEntry | undefined;
    commitUndo(entryId: string): void;
    commitRedo(entryId: string): void;
    clear(): void;
    export(): HistoryState;
    restore(state: HistoryState): void;
    private canMerge;
    private changedBlockId;
    private trim;
    private totalBytes;
}
//# sourceMappingURL=HistoryManager.d.ts.map