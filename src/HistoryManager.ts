import { approximateBytes } from './SnapshotService.js';
import type { HistoryEntry, HistoryState } from './types.js';

export interface HistoryManagerConfig {
  maxEntries: number;
  mergeWindowMs: number;
  maxBytes?: number;
}

export class HistoryManager {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly config: HistoryManagerConfig) {}

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public push(entry: HistoryEntry): void {
    this.redoStack = [];

    const previous = this.undoStack.at(-1);

    if (previous !== undefined && this.canMerge(previous, entry)) {
      previous.after = entry.after;
      previous.createdAt = entry.createdAt;
      previous.events = entry.events;
    } else {
      this.undoStack.push(entry);
    }

    this.trim();
  }

  public peekUndo(): HistoryEntry | undefined {
    return this.undoStack.at(-1);
  }

  public peekRedo(): HistoryEntry | undefined {
    return this.redoStack.at(-1);
  }

  public commitUndo(entryId: string): void {
    const entry = this.undoStack.at(-1);

    if (entry?.id !== entryId) {
      throw new Error('Undo history changed while the operation was running.');
    }

    this.undoStack.pop();
    this.redoStack.push(entry);
  }

  public commitRedo(entryId: string): void {
    const entry = this.redoStack.at(-1);

    if (entry?.id !== entryId) {
      throw new Error('Redo history changed while the operation was running.');
    }

    this.redoStack.pop();
    this.undoStack.push(entry);
  }

  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  public export(): HistoryState {
    return {
      undoStack: [ ...this.undoStack ],
      redoStack: [ ...this.redoStack ],
    };
  }

  public restore(state: HistoryState): void {
    this.undoStack = [ ...state.undoStack ];
    this.redoStack = [ ...state.redoStack ];
    this.trim();
  }

  private canMerge(previous: HistoryEntry, current: HistoryEntry): boolean {
    if (current.createdAt - previous.createdAt > this.config.mergeWindowMs) {
      return false;
    }

    const previousBlockId = this.changedBlockId(previous);
    const currentBlockId = this.changedBlockId(current);

    return previousBlockId !== undefined && previousBlockId === currentBlockId;
  }

  private changedBlockId(entry: HistoryEntry): string | undefined {
    if (entry.events.length === 0 || entry.events.some(({ type }) => type !== 'block-changed')) {
      return undefined;
    }

    const blockIds = new Set(entry.events.map(({ blockId }) => blockId));

    return blockIds.size === 1 ? blockIds.values().next().value : undefined;
  }

  private trim(): void {
    while (this.undoStack.length + this.redoStack.length > this.config.maxEntries) {
      if (this.undoStack.length > 0) {
        this.undoStack.shift();
      } else {
        this.redoStack.shift();
      }
    }

    if (this.config.maxBytes === undefined) {
      return;
    }

    while (
      this.undoStack.length + this.redoStack.length > 1
      && this.totalBytes() > this.config.maxBytes
    ) {
      if (this.undoStack.length > 0) {
        this.undoStack.shift();
      } else {
        this.redoStack.shift();
      }
    }
  }

  private totalBytes(): number {
    return [...this.undoStack, ...this.redoStack]
      .reduce((total, entry) => total + approximateBytes(entry), 0);
  }
}
