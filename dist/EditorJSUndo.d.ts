import type { API, BlockMutationEvent } from '@editorjs/editorjs';
import type { EditorJSUndoConfig } from './types.js';
export declare class EditorJSUndo {
    readonly isReady: Promise<void>;
    private readonly editor;
    private readonly instanceId;
    private readonly queue;
    private readonly history;
    private readonly snapshots;
    private readonly onError?;
    private readonly persistenceConfig?;
    private readonly shortcutsEnabled;
    private readonly holder?;
    private storage?;
    private shortcuts?;
    private shadowState?;
    private initialized;
    private destroyed;
    private applyingHistory;
    private runningOperation;
    constructor(config: EditorJSUndoConfig);
    get canUndo(): boolean;
    get canRedo(): boolean;
    handleChange(_api: API, event: BlockMutationEvent | BlockMutationEvent[]): Promise<void>;
    undo(): Promise<boolean>;
    redo(): Promise<boolean>;
    clear(): Promise<void>;
    destroy(): void;
    private initialize;
    private initializeStorage;
    private persist;
    private disableStorage;
    private run;
    private requireShadowState;
    private resolveHolder;
    private describeEvents;
    private reportError;
}
//# sourceMappingURL=EditorJSUndo.d.ts.map