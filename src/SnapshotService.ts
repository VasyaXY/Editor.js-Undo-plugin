import type {
  BlockStateAdapter,
  CapturedBlockState,
  EditorJSInstance,
  HistorySnapshot
} from './types.js';

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const HEX_RADIX = 16;
const HASH_LENGTH = 8;

export function cloneValue<Value>(value: Value): Value {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as Value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const item = (value as Record<string, unknown>)[key];

        if (item !== undefined) {
          result[key] = canonicalize(item);
        }

        return result;
      }, {});
  }

  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function approximateBytes(value: unknown): number {
  return canonicalStringify(value).length * 2;
}

export class SnapshotService {
  constructor(
    private readonly editor: EditorJSInstance,
    private readonly stateAdapters: Record<string, BlockStateAdapter> = {}
  ) {}

  public async capture(): Promise<HistorySnapshot> {
    const data = cloneValue(await this.editor.save());
    const blockStates: Record<string, CapturedBlockState> = {};

    for (const blockData of data.blocks) {
      if (blockData.id === undefined) {
        continue;
      }

      const adapter = this.stateAdapters[blockData.type];
      const block = this.editor.blocks.getById(blockData.id);

      if (adapter === undefined || block === null) {
        continue;
      }

      blockStates[blockData.id] = {
        tool: blockData.type,
        state: cloneValue(await adapter.capture(block)),
      };
    }

    const currentIndex = this.editor.blocks.getCurrentBlockIndex();
    const focusedBlockId = currentIndex >= 0
      ? this.editor.blocks.getBlockByIndex(currentIndex)?.id
      : undefined;

    return {
      data,
      ...(Object.keys(blockStates).length > 0 ? { blockStates } : {}),
      ...(focusedBlockId !== undefined ? { focusedBlockId } : {}),
    };
  }

  public async restore(snapshot: HistorySnapshot): Promise<void> {
    let currentScroll = window.scrollY;
    await this.editor.blocks.render(cloneValue(snapshot.data));

    for (const [blockId, captured] of Object.entries(snapshot.blockStates ?? {})) {
      const adapter = this.stateAdapters[captured.tool];
      const block = this.editor.blocks.getById(blockId);

      if (adapter !== undefined && block !== null) {
        await adapter.restore(block, cloneValue(captured.state));
      }
    }

    if (
      snapshot.focusedBlockId !== undefined
      && this.editor.blocks.getById(snapshot.focusedBlockId) !== null
    ) {
      try {
        this.editor.blocks.getById(snapshot.focusedBlockId).call('_scrollToMe', {fast: true});
      } catch (e) {}
      this.editor.caret.setToBlock(snapshot.focusedBlockId);
    } else {
      window.scrollTo(0, currentScroll);
    }
  }

  public clone(snapshot: HistorySnapshot): HistorySnapshot {
    return cloneValue(snapshot);
  }

  public equals(left: HistorySnapshot, right: HistorySnapshot): boolean {
    return canonicalStringify({
      blocks: left.data.blocks,
      blockStates: left.blockStates ?? {},
    }) === canonicalStringify({
      blocks: right.data.blocks,
      blockStates: right.blockStates ?? {},
    });
  }

  public hasSameDocument(left: HistorySnapshot, right: HistorySnapshot): boolean {
    return canonicalStringify(left.data.blocks) === canonicalStringify(right.data.blocks);
  }

  public fingerprint(snapshot: HistorySnapshot): string {
    const value = canonicalStringify(snapshot.data.blocks);
    let hash = FNV_OFFSET_BASIS;

    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, FNV_PRIME);
    }

    return (hash >>> 0).toString(HEX_RADIX).padStart(HASH_LENGTH, '0');
  }
}
