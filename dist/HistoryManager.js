import { approximateBytes } from './SnapshotService.js';
export class HistoryManager {
    constructor(config) {
        this.config = config;
        this.undoStack = [];
        this.redoStack = [];
    }
    get canUndo() {
        return this.undoStack.length > 0;
    }
    get canRedo() {
        return this.redoStack.length > 0;
    }
    push(entry) {
        this.redoStack = [];
        const previous = this.undoStack.at(-1);
        if (previous !== undefined && this.canMerge(previous, entry)) {
            previous.after = entry.after;
            previous.createdAt = entry.createdAt;
            previous.events = entry.events;
        }
        else {
            this.undoStack.push(entry);
        }
        this.trim();
    }
    peekUndo() {
        return this.undoStack.at(-1);
    }
    peekRedo() {
        return this.redoStack.at(-1);
    }
    commitUndo(entryId) {
        const entry = this.undoStack.at(-1);
        if (entry?.id !== entryId) {
            throw new Error('Undo history changed while the operation was running.');
        }
        this.undoStack.pop();
        this.redoStack.push(entry);
    }
    commitRedo(entryId) {
        const entry = this.redoStack.at(-1);
        if (entry?.id !== entryId) {
            throw new Error('Redo history changed while the operation was running.');
        }
        this.redoStack.pop();
        this.undoStack.push(entry);
    }
    clear() {
        this.undoStack = [];
        this.redoStack = [];
    }
    export() {
        return {
            undoStack: [...this.undoStack],
            redoStack: [...this.redoStack],
        };
    }
    restore(state) {
        this.undoStack = [...state.undoStack];
        this.redoStack = [...state.redoStack];
        this.trim();
    }
    canMerge(previous, current) {
        if (current.createdAt - previous.createdAt > this.config.mergeWindowMs) {
            return false;
        }
        const previousBlockId = this.changedBlockId(previous);
        const currentBlockId = this.changedBlockId(current);
        return previousBlockId !== undefined && previousBlockId === currentBlockId;
    }
    changedBlockId(entry) {
        if (entry.events.length === 0 || entry.events.some(({ type }) => type !== 'block-changed')) {
            return undefined;
        }
        const blockIds = new Set(entry.events.map(({ blockId }) => blockId));
        return blockIds.size === 1 ? blockIds.values().next().value : undefined;
    }
    trim() {
        while (this.undoStack.length + this.redoStack.length > this.config.maxEntries) {
            if (this.undoStack.length > 0) {
                this.undoStack.shift();
            }
            else {
                this.redoStack.shift();
            }
        }
        if (this.config.maxBytes === undefined) {
            return;
        }
        while (this.undoStack.length + this.redoStack.length > 1
            && this.totalBytes() > this.config.maxBytes) {
            if (this.undoStack.length > 0) {
                this.undoStack.shift();
            }
            else {
                this.redoStack.shift();
            }
        }
    }
    totalBytes() {
        return [...this.undoStack, ...this.redoStack]
            .reduce((total, entry) => total + approximateBytes(entry), 0);
    }
}
//# sourceMappingURL=HistoryManager.js.map