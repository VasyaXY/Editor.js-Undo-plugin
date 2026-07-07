export class ShortcutController {
    constructor(config) {
        this.config = config;
        this.handleKeyDown = (event) => {
            const modifierPressed = event.ctrlKey || event.metaKey;
            if (event.defaultPrevented
                || event.isComposing
                || !modifierPressed
                || event.altKey
                || event.key.toLowerCase() !== 'z') {
                return;
            }
            const isRedo = event.shiftKey;
            const canRun = isRedo ? this.config.canRedo() : this.config.canUndo();
            if (!canRun) {
                return;
            }
            event.preventDefault();
            const operation = isRedo ? this.config.redo() : this.config.undo();
            void operation.catch(this.config.onError);
        };
        config.holder.addEventListener('keydown', this.handleKeyDown);
    }
    destroy() {
        this.config.holder.removeEventListener('keydown', this.handleKeyDown);
    }
}
//# sourceMappingURL=ShortcutController.js.map