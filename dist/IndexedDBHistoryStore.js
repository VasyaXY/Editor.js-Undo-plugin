import { approximateBytes } from './SnapshotService.js';
const DATABASE_VERSION = 1;
const SCHEMA_VERSION = 1;
const INSTANCES_STORE = 'instances';
const ENTRIES_STORE = 'entries';
const ENTRIES_BY_INSTANCE = 'byInstance';
const ENTRIES_BY_INSTANCE_AND_CREATED_AT = 'byInstanceAndCreatedAt';
export class HistoryConflictError extends Error {
    constructor(instanceId) {
        super(`IndexedDB history for "${instanceId}" was changed in another context.`);
        this.name = 'HistoryConflictError';
    }
}
function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
    });
}
function transactionCompleted(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    });
}
function isRecord(value) {
    return value !== null && typeof value === 'object';
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function isSnapshot(value) {
    return isRecord(value)
        && isRecord(value.data)
        && Array.isArray(value.data.blocks);
}
function isMetadata(value, instanceId) {
    return isRecord(value)
        && value.instanceId === instanceId
        && value.schemaVersion === SCHEMA_VERSION
        && typeof value.revision === 'number'
        && typeof value.shadowFingerprint === 'string'
        && isStringArray(value.undoOrder)
        && isStringArray(value.redoOrder)
        && isSnapshot(value.shadowState);
}
function isEntry(value, instanceId) {
    return isRecord(value)
        && value.instanceId === instanceId
        && typeof value.id === 'string'
        && typeof value.createdAt === 'number'
        && Array.isArray(value.events)
        && isSnapshot(value.before)
        && isSnapshot(value.after);
}
export class IndexedDBHistoryStore {
    constructor(factory, databaseName = 'editorjs-undo') {
        this.factory = factory;
        this.databaseName = databaseName;
        this.revisions = new Map();
    }
    async open() {
        if (this.database !== undefined) {
            return;
        }
        const request = this.factory.open(this.databaseName, DATABASE_VERSION);
        this.database = await new Promise((resolve, reject) => {
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
                if (entries !== undefined
                    && !entries.indexNames.contains(ENTRIES_BY_INSTANCE_AND_CREATED_AT)) {
                    entries.createIndex(ENTRIES_BY_INSTANCE_AND_CREATED_AT, ['instanceId', 'createdAt']);
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
    async load(instanceId) {
        const database = this.getDatabase();
        const transaction = database.transaction([INSTANCES_STORE, ENTRIES_STORE], 'readonly');
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
        const entries = new Map();
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
                .filter((entry) => entry !== undefined),
            redoStack: metadataValue.redoOrder
                .map((id) => entries.get(id))
                .filter((entry) => entry !== undefined),
            shadowState: metadataValue.shadowState,
            shadowFingerprint: metadataValue.shadowFingerprint,
        };
    }
    async save(instanceId, history, shadowState, shadowFingerprint, editorVersion) {
        const database = this.getDatabase();
        const expectedRevision = this.revisions.get(instanceId) ?? 0;
        const transaction = database.transaction([INSTANCES_STORE, ENTRIES_STORE], 'readwrite');
        const metadataStore = transaction.objectStore(INSTANCES_STORE);
        const entriesStore = transaction.objectStore(ENTRIES_STORE);
        const completion = transactionCompleted(transaction);
        const entries = [...history.undoStack, ...history.redoStack];
        const desiredIds = new Set(entries.map(({ id }) => id));
        let operationError;
        metadataStore.get(instanceId).onsuccess = (event) => {
            try {
                const current = event.target.result;
                const currentRevision = isRecord(current) && typeof current.revision === 'number'
                    ? current.revision
                    : 0;
                if (currentRevision !== expectedRevision) {
                    operationError = new HistoryConflictError(instanceId);
                    transaction.abort();
                    return;
                }
                for (const entry of entries) {
                    const record = {
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
                const metadata = {
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
            }
            catch (error) {
                operationError = error instanceof Error ? error : new Error(String(error));
                transaction.abort();
            }
        };
        try {
            await completion;
        }
        catch (error) {
            throw operationError ?? error;
        }
        this.revisions.set(instanceId, expectedRevision + 1);
    }
    async clear(instanceId) {
        const database = this.getDatabase();
        const transaction = database.transaction([INSTANCES_STORE, ENTRIES_STORE], 'readwrite');
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
    close() {
        this.database?.close();
        this.database = undefined;
        this.revisions.clear();
    }
    getDatabase() {
        if (this.database === undefined) {
            throw new Error('IndexedDB history store is not open.');
        }
        return this.database;
    }
}
//# sourceMappingURL=IndexedDBHistoryStore.js.map