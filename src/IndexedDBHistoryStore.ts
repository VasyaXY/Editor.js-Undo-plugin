import { approximateBytes } from './SnapshotService.js';
import type {
  HistoryEntry,
  HistorySnapshot,
  HistoryState,
  PersistedHistory
} from './types.js';

const DATABASE_VERSION = 1;
const SCHEMA_VERSION = 1;
const INSTANCES_STORE = 'instances';
const ENTRIES_STORE = 'entries';
const ENTRIES_BY_INSTANCE = 'byInstance';
const ENTRIES_BY_INSTANCE_AND_CREATED_AT = 'byInstanceAndCreatedAt';

interface HistoryMetadataRecordV1 {
  instanceId: string;
  schemaVersion: 1;
  editorVersion?: string;
  updatedAt: number;
  revision: number;
  shadowFingerprint: string;
  undoOrder: string[];
  redoOrder: string[];
  shadowState: HistorySnapshot;
}

interface HistoryEntryRecordV1 extends HistoryEntry {
  instanceId: string;
  approximateBytes: number;
}

export class HistoryConflictError extends Error {
  constructor(instanceId: string) {
    super(`IndexedDB history for "${instanceId}" was changed in another context.`);
    this.name = 'HistoryConflictError';
  }
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionCompleted(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error('IndexedDB transaction was aborted.')
    );
    transaction.onerror = () => reject(
      transaction.error ?? new Error('IndexedDB transaction failed.')
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isSnapshot(value: unknown): value is HistorySnapshot {
  return isRecord(value)
    && isRecord(value.data)
    && Array.isArray(value.data.blocks);
}

function isMetadata(value: unknown, instanceId: string): value is HistoryMetadataRecordV1 {
  return isRecord(value)
    && value.instanceId === instanceId
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.revision === 'number'
    && typeof value.shadowFingerprint === 'string'
    && isStringArray(value.undoOrder)
    && isStringArray(value.redoOrder)
    && isSnapshot(value.shadowState);
}

function isEntry(value: unknown, instanceId: string): value is HistoryEntryRecordV1 {
  return isRecord(value)
    && value.instanceId === instanceId
    && typeof value.id === 'string'
    && typeof value.createdAt === 'number'
    && Array.isArray(value.events)
    && isSnapshot(value.before)
    && isSnapshot(value.after);
}

export class IndexedDBHistoryStore {
  private database?: IDBDatabase;
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = 'editorjs-undo'
  ) {}

  public async open(): Promise<void> {
    if (this.database !== undefined) {
      return;
    }

    const request = this.factory.open(this.databaseName, DATABASE_VERSION);

    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;

      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;

        if (!database.objectStoreNames.contains(INSTANCES_STORE)) {
          database.createObjectStore(INSTANCES_STORE, {
            keyPath: 'instanceId',
          });
        }

        const entries = database.objectStoreNames.contains(ENTRIES_STORE)
          ? transaction?.objectStore(ENTRIES_STORE)
          : database.createObjectStore(ENTRIES_STORE, {
            keyPath: ['instanceId', 'id'],
          });

        if (entries !== undefined && !entries.indexNames.contains(ENTRIES_BY_INSTANCE)) {
          entries.createIndex(ENTRIES_BY_INSTANCE, 'instanceId');
        }

        if (
          entries !== undefined
          && !entries.indexNames.contains(ENTRIES_BY_INSTANCE_AND_CREATED_AT)
        ) {
          entries.createIndex(
            ENTRIES_BY_INSTANCE_AND_CREATED_AT,
            ['instanceId', 'createdAt']
          );
        }
      };

      request.onsuccess = () => {
        if (settled) {
          request.result.close();

          return;
        }

        settled = true;
        resolve(request.result);
      };

      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error ?? new Error('Could not open IndexedDB.'));
        }
      };

      request.onblocked = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`IndexedDB upgrade for "${this.databaseName}" is blocked.`));
        }
      };
    });

    this.database.onversionchange = () => {
      this.close();
    };
  }

  public async load(instanceId: string): Promise<PersistedHistory | undefined> {
    const database = this.getDatabase();
    const transaction = database.transaction(
      [INSTANCES_STORE, ENTRIES_STORE],
      'readonly'
    );
    const metadataRequest = transaction.objectStore(INSTANCES_STORE).get(instanceId);
    const entriesRequest = transaction
      .objectStore(ENTRIES_STORE)
      .index(ENTRIES_BY_INSTANCE)
      .getAll(instanceId);
    const [metadataValue, entryValues] = await Promise.all([
      requestResult(metadataRequest),
      requestResult(entriesRequest),
      transactionCompleted(transaction),
    ]);

    if (metadataValue === undefined) {
      this.revisions.set(instanceId, 0);

      return undefined;
    }

    if (!isMetadata(metadataValue, instanceId)) {
      throw new Error(`IndexedDB history metadata for "${instanceId}" is invalid.`);
    }

    const entries = new Map<string, HistoryEntry>();

    for (const entryValue of entryValues) {
      if (!isEntry(entryValue, instanceId)) {
        throw new Error(`IndexedDB history entry for "${instanceId}" is invalid.`);
      }

      entries.set(entryValue.id, entryValue);
    }

    this.revisions.set(instanceId, metadataValue.revision);

    return {
      undoStack: metadataValue.undoOrder
        .map((id) => entries.get(id))
        .filter((entry): entry is HistoryEntry => entry !== undefined),
      redoStack: metadataValue.redoOrder
        .map((id) => entries.get(id))
        .filter((entry): entry is HistoryEntry => entry !== undefined),
      shadowState: metadataValue.shadowState,
      shadowFingerprint: metadataValue.shadowFingerprint,
    };
  }

  public async save(
    instanceId: string,
    history: HistoryState,
    shadowState: HistorySnapshot,
    shadowFingerprint: string,
    editorVersion?: string
  ): Promise<void> {
    const database = this.getDatabase();
    const expectedRevision = this.revisions.get(instanceId) ?? 0;
    const transaction = database.transaction(
      [INSTANCES_STORE, ENTRIES_STORE],
      'readwrite'
    );
    const metadataStore = transaction.objectStore(INSTANCES_STORE);
    const entriesStore = transaction.objectStore(ENTRIES_STORE);
    const completion = transactionCompleted(transaction);
    const entries = [...history.undoStack, ...history.redoStack];
    const desiredIds = new Set(entries.map(({ id }) => id));
    let operationError: Error | undefined;

    metadataStore.get(instanceId).onsuccess = (event) => {
      try {
        const current = (event.target as IDBRequest<unknown>).result;
        const currentRevision = isRecord(current) && typeof current.revision === 'number'
          ? current.revision
          : 0;

        if (currentRevision !== expectedRevision) {
          operationError = new HistoryConflictError(instanceId);
          transaction.abort();

          return;
        }

        for (const entry of entries) {
          const record: HistoryEntryRecordV1 = {
            ...entry,
            instanceId,
            approximateBytes: approximateBytes(entry),
          };

          entriesStore.put(record);
        }

        const cursorRequest = entriesStore
          .index(ENTRIES_BY_INSTANCE)
          .openKeyCursor(instanceId);

        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;

          if (cursor === null) {
            return;
          }

          const primaryKey = cursor.primaryKey;
          const entryId = Array.isArray(primaryKey) ? primaryKey[1] : undefined;

          if (typeof entryId === 'string' && !desiredIds.has(entryId)) {
            entriesStore.delete(primaryKey);
          }

          cursor.continue();
        };

        const nextRevision = expectedRevision + 1;
        const metadata: HistoryMetadataRecordV1 = {
          instanceId,
          schemaVersion: SCHEMA_VERSION,
          ...(editorVersion !== undefined ? { editorVersion } : {}),
          updatedAt: Date.now(),
          revision: nextRevision,
          shadowFingerprint,
          undoOrder: history.undoStack.map(({ id }) => id),
          redoOrder: history.redoStack.map(({ id }) => id),
          shadowState,
        };

        metadataStore.put(metadata);
      } catch (error) {
        operationError = error instanceof Error ? error : new Error(String(error));
        transaction.abort();
      }
    };

    try {
      await completion;
    } catch (error) {
      throw operationError ?? error;
    }

    this.revisions.set(instanceId, expectedRevision + 1);
  }

  public async clear(instanceId: string): Promise<void> {
    const database = this.getDatabase();
    const transaction = database.transaction(
      [INSTANCES_STORE, ENTRIES_STORE],
      'readwrite'
    );
    const entriesStore = transaction.objectStore(ENTRIES_STORE);

    transaction.objectStore(INSTANCES_STORE).delete(instanceId);

    const cursorRequest = entriesStore
      .index(ENTRIES_BY_INSTANCE)
      .openKeyCursor(instanceId);

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;

      if (cursor !== null) {
        entriesStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };

    await transactionCompleted(transaction);
    this.revisions.set(instanceId, 0);
  }

  public close(): void {
    this.database?.close();
    this.database = undefined;
    this.revisions.clear();
  }

  private getDatabase(): IDBDatabase {
    if (this.database === undefined) {
      throw new Error('IndexedDB history store is not open.');
    }

    return this.database;
  }
}
