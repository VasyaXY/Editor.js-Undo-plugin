import type { BlockStateAdapter, EditorJSInstance, HistorySnapshot } from './types.js';
export declare function cloneValue<Value>(value: Value): Value;
export declare function canonicalStringify(value: unknown): string;
export declare function approximateBytes(value: unknown): number;
export declare class SnapshotService {
    private readonly editor;
    private readonly stateAdapters;
    constructor(editor: EditorJSInstance, stateAdapters?: Record<string, BlockStateAdapter>);
    capture(): Promise<HistorySnapshot>;
    restore(snapshot: HistorySnapshot): Promise<void>;
    clone(snapshot: HistorySnapshot): HistorySnapshot;
    equals(left: HistorySnapshot, right: HistorySnapshot): boolean;
    hasSameDocument(left: HistorySnapshot, right: HistorySnapshot): boolean;
    fingerprint(snapshot: HistorySnapshot): string;
}
//# sourceMappingURL=SnapshotService.d.ts.map