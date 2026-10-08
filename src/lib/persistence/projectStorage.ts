/**
 * Persistence.
 *
 * The UI never learns whether a project lives in IndexedDB or localStorage:
 * both implementations satisfy one interface, and the app picks the best
 * available backend at runtime.
 */

import { deserializeProject, serializeProject } from '../model/project';
import type { Project, ProjectSummary } from '../model/types';

export interface ProjectStorage {
	save(project: Project): Promise<void>;
	load(id: string): Promise<Project | null>;
	delete(id: string): Promise<void>;
	list(): Promise<ProjectSummary[]>;
}

export const CURRENT_PROJECT_KEY = 'linesynth.currentProjectId';
const STORAGE_PREFIX = 'linesynth.project.';
const INDEX_DB_NAME = 'linesynth';
const INDEX_DB_VERSION = 1;
const STORE_NAME = 'projects';

export class StorageError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown
	) {
		super(message);
		this.name = 'StorageError';
	}
}

function summarize(project: Project): ProjectSummary {
	return {
		id: project.id,
		name: project.name,
		updatedAt: project.updatedAt,
		trackCount: project.tracks.length
	};
}

/* ------------------------------------------------------------- localStorage */

export class LocalStorageProjectStore implements ProjectStorage {
	async save(project: Project): Promise<void> {
		try {
			localStorage.setItem(
				`${STORAGE_PREFIX}${project.id}`,
				serializeProject({ ...project, updatedAt: Date.now() })
			);
			localStorage.setItem(CURRENT_PROJECT_KEY, project.id);
		} catch (error) {
			throw new StorageError('Could not save project to local storage', error);
		}
	}

	async load(id: string): Promise<Project | null> {
		const raw = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
		if (!raw) return null;
		return deserializeProject(raw);
	}

	async delete(id: string): Promise<void> {
		localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
		if (localStorage.getItem(CURRENT_PROJECT_KEY) === id) {
			localStorage.removeItem(CURRENT_PROJECT_KEY);
		}
	}

	async list(): Promise<ProjectSummary[]> {
		const summaries: ProjectSummary[] = [];
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key?.startsWith(STORAGE_PREFIX)) continue;
			const raw = localStorage.getItem(key);
			if (!raw) continue;
			try {
				const project = deserializeProject(raw);
				summaries.push(summarize(project));
			} catch {
				// a corrupt entry must never break the library listing
				continue;
			}
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

/* --------------------------------------------------------------- indexedDB */

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(INDEX_DB_NAME, INDEX_DB_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: 'id' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(new StorageError('Could not open project database', request.error));
	});
}

function transaction<T>(
	database: IDBDatabase,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, mode);
		const request = run(transaction.objectStore(STORE_NAME));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(new StorageError('Storage request failed', request.error));
	});
}

export class IndexedDbProjectStore implements ProjectStorage {
	private database: Promise<IDBDatabase> | null = null;

	private db(): Promise<IDBDatabase> {
		if (!this.database) this.database = openDatabase();
		return this.database;
	}

	async save(project: Project): Promise<void> {
		const database = await this.db();
		const record = {
			id: project.id,
			name: project.name,
			trackCount: project.tracks.length,
			updatedAt: Date.now(),
			document: serializeProject(project)
		};
		await transaction(database, 'readwrite', (store) => store.put(record));
		localStorage.setItem(CURRENT_PROJECT_KEY, project.id);
	}

	async load(id: string): Promise<Project | null> {
		const database = await this.db();
		const record = await transaction<{ document: string } | undefined>(
			database,
			'readonly',
			(store) => store.get(id)
		);
		if (!record) return null;
		return deserializeProject(record.document);
	}

	async delete(id: string): Promise<void> {
		const database = await this.db();
		await transaction(database, 'readwrite', (store) => store.delete(id));
		if (localStorage.getItem(CURRENT_PROJECT_KEY) === id) {
			localStorage.removeItem(CURRENT_PROJECT_KEY);
		}
	}

	async list(): Promise<ProjectSummary[]> {
		const database = await this.db();
		const records = await transaction<
			{ id: string; name: string; updatedAt: number; trackCount: number }[]
		>(database, 'readonly', (store) => store.getAll());
		return records
			.map((record) => ({
				id: record.id,
				name: record.name,
				updatedAt: record.updatedAt,
				trackCount: record.trackCount
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}
}

/* -------------------------------------------------------------- selection */

export function createProjectStorage(): ProjectStorage {
	if (typeof indexedDB !== 'undefined') {
		return new IndexedDbProjectStore();
	}
	if (typeof localStorage !== 'undefined') {
		return new LocalStorageProjectStore();
	}
	// In-memory last resort so the app still runs (e.g. during SSR prerender).
	const memory = new Map<string, string>();
	return {
		async save(project) {
			memory.set(project.id, serializeProject(project));
		},
		async load(id) {
			const raw = memory.get(id);
			return raw ? deserializeProject(raw) : null;
		},
		async delete(id) {
			memory.delete(id);
		},
		async list() {
			return [];
		}
	};
}

export function lastProjectId(): string | null {
	try {
		return localStorage.getItem(CURRENT_PROJECT_KEY);
	} catch {
		return null;
	}
}

/* ---------------------------------------------------------- preferences */

export function readPreference<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(`linesynth.pref.${key}`);
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function writePreference(key: string, value: unknown): void {
	try {
		localStorage.setItem(`linesynth.pref.${key}`, JSON.stringify(value));
	} catch {
		// preferences are best-effort and never block the editor
	}
}
