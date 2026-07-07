import type { HistorySnapshot, HistoryState, PersistedHistory } from './types.js';
export declare class HistoryConflictError extends Error {
    constructor(instanceId: string);
}
export declare class IndexedDBHistoryStore {
    private readonly factory;
    private readonly databaseName;
    private database?;
    private readonly revisions;
    constructor(factory: IDBFactory, databaseName?: string);
    open(): Promise<void>;
    load(instanceId: string): Promise<PersistedHistory | undefined>;
    save(instanceId: string, history: HistoryState, shadowState: HistorySnapshot, shadowFingerprint: string, editorVersion?: string): Promise<void>;
    clear(instanceId: string): Promise<void>;
    close(): void;
    private getDatabase;
}
//# sourceMappingURL=IndexedDBHistoryStore.d.ts.map