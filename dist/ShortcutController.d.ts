export interface ShortcutControllerConfig {
    holder: HTMLElement;
    canUndo: () => boolean;
    canRedo: () => boolean;
    undo: () => Promise<boolean>;
    redo: () => Promise<boolean>;
    onError: (error: unknown) => void;
}
export declare class ShortcutController {
    private readonly config;
    constructor(config: ShortcutControllerConfig);
    destroy(): void;
    private readonly handleKeyDown;
}
//# sourceMappingURL=ShortcutController.d.ts.map