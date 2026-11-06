/**
 * Query history per database (plan 22), kept in the browser's IndexedDB (`skiff-studio-history`)
 * with an in-memory fallback when IndexedDB is missing or refuses (private windows, SSR, tests).
 * Only the input and run metadata are stored, never results. Every call is best effort: history
 * must never break running a query.
 */

export interface HistoryEntry {
	input: string;
	/** ISO timestamp of when the run started. */
	ranAt: string;
	ms: number | null;
	rows: number;
	ok: boolean;
}

export interface QueryHistory {
	/** Newest first. */
	list(): Promise<HistoryEntry[]>;
	add(entry: HistoryEntry): Promise<void>;
	clear(): Promise<void>;
}

export const HISTORY_LIMIT = 200;
const DB_NAME = 'skiff-studio-history';
const STORE = 'history';

/** Memory fallback, shared per page so every tab of one database sees the same list. */
const memory = new Map<string, HistoryEntry[]>();

function prepend(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
	return [entry, ...entries].slice(0, HISTORY_LIMIT);
}

function memoryHistory(database: string): QueryHistory {
	return {
		async list() {
			return [...(memory.get(database) ?? [])];
		},
		async add(entry) {
			memory.set(database, prepend(memory.get(database) ?? [], entry));
		},
		async clear() {
			memory.delete(database);
		}
	};
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
	opening ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = factory.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			// One record per database: `{ database, entries }`, newest first.
			if (!req.result.objectStoreNames.contains(STORE))
				req.result.createObjectStore(STORE, { keyPath: 'database' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('IndexedDB open blocked'));
	}).catch((error) => {
		opening = null;
		throw error;
	});
	return opening;
}

function indexedHistory(database: string, factory: IDBFactory): QueryHistory {
	const fallback = memoryHistory(database);

	async function read(): Promise<HistoryEntry[]> {
		const db = await openDb(factory);
		const record = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(database))) as
			| { entries?: HistoryEntry[] }
			| undefined;
		return Array.isArray(record?.entries) ? record.entries : [];
	}

	return {
		async list() {
			try {
				return await read();
			} catch {
				return fallback.list();
			}
		},
		async add(entry) {
			try {
				const db = await openDb(factory);
				// Read and write in one transaction so two tabs adding at once don't lose an entry.
				const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
				const record = (await request(store.get(database))) as { entries?: HistoryEntry[] } | undefined;
				const entries = Array.isArray(record?.entries) ? record.entries : [];
				await request(store.put({ database, entries: prepend(entries, entry) }));
			} catch {
				await fallback.add(entry);
			}
		},
		async clear() {
			try {
				const db = await openDb(factory);
				await request(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(database));
			} catch {
				// Ignore: there is nothing more useful to do.
			}
			await fallback.clear();
		}
	};
}

/**
 * History for one database. `factory` defaults to the global `indexedDB`; pass `null` to force
 * the in-memory store.
 */
export function openHistory(database: string, factory?: IDBFactory | null): QueryHistory {
	let idb: IDBFactory | null = null;
	try {
		idb = factory === undefined ? (globalThis.indexedDB ?? null) : factory;
	} catch {
		// Accessing `indexedDB` can throw in sandboxed frames.
		idb = null;
	}
	return idb ? indexedHistory(database, idb) : memoryHistory(database);
}
