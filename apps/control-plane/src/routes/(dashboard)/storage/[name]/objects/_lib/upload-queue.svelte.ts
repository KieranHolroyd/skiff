import { formatBytes } from '../../../../_lib/format.js';
import { folderKey, uploadKey, type Picked } from './picked.js';

/**
 * A client-side upload queue for the object browser. Each file is its own `PUT` to the object REST
 * endpoint (session cookie, same origin), a few at a time, with byte-level progress from XHR.
 * Empty directories become folder markers so a dropped tree keeps its shape.
 */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed' | 'cancelled';

export class UploadItem {
	readonly id: number;
	readonly bucket: string;
	readonly key: string;
	readonly kind: 'file' | 'folder';
	readonly file: File | null;
	readonly size: number;
	loaded = $state(0);
	status = $state<UploadStatus>('queued');
	error = $state<string | null>(null);
	xhr: XMLHttpRequest | null = null;

	constructor(id: number, bucket: string, key: string, file: File | null) {
		this.id = id;
		this.bucket = bucket;
		this.key = key;
		this.kind = file ? 'file' : 'folder';
		this.file = file;
		this.size = file?.size ?? 0;
	}

	get finished(): boolean {
		return this.status === 'done' || this.status === 'failed' || this.status === 'cancelled';
	}
}

export interface UploadQueueOptions {
	storage: () => string;
	maxBytes: () => number;
	/** Called (throttled) as uploads land, and once when the queue drains. */
	onProgress: () => void;
	/** Called once per batch when every item has finished. */
	onDrained: (summary: { done: number; failed: number; cancelled: number }) => void;
	concurrency?: number;
}

function errorMessage(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as {
			message?: string;
			error?: string;
			issues?: { message: string }[];
		};
		const message = parsed.message ?? parsed.issues?.[0]?.message ?? parsed.error;
		if (message) return message;
	} catch {
		// Not JSON; fall through.
	}
	if (status === 413) return 'Too large for a dashboard upload.';
	if (status === 403) return 'You do not have permission to upload here.';
	return status ? `Upload failed (HTTP ${status}).` : 'Network error.';
}

export class UploadQueue {
	items = $state<UploadItem[]>([]);
	#nextId = 1;
	#active = 0;
	#options: UploadQueueOptions;
	#progressTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: UploadQueueOptions) {
		this.#options = options;
	}

	get concurrency(): number {
		return this.#options.concurrency ?? 4;
	}

	totalBytes = $derived(
		this.items.reduce((sum, item) => (item.status === 'cancelled' ? sum : sum + item.size), 0)
	);
	loadedBytes = $derived(
		this.items.reduce(
			(sum, item) => (item.status === 'cancelled' ? sum : sum + Math.min(item.loaded, item.size)),
			0
		)
	);
	counts = $derived.by(() => {
		const counts = { queued: 0, uploading: 0, done: 0, failed: 0, cancelled: 0 };
		for (const item of this.items) counts[item.status] += 1;
		return counts;
	});
	running = $derived(this.counts.queued + this.counts.uploading > 0);
	/** 0–1 across the whole batch; folder markers count as one byte so an all-folder batch moves. */
	progress = $derived.by(() => {
		const live = this.items.filter((item) => item.status !== 'cancelled');
		if (live.length === 0) return 0;
		const weight = (item: UploadItem) => Math.max(item.size, 1);
		const total = live.reduce((sum, item) => sum + weight(item), 0);
		const done = live.reduce(
			(sum, item) => sum + (item.finished ? weight(item) : Math.min(item.loaded, item.size)),
			0
		);
		return done / total;
	});

	/** Queue a pick for `bucket` under `prefix`. Returns how many items were queued. */
	add(bucket: string, prefix: string, picked: Picked): number {
		const max = this.#options.maxBytes();
		const added: UploadItem[] = [];
		const pending = this.running ? this.items.filter((item) => !item.finished) : [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupe, never rendered
		const seen = new Set(pending.map((item) => `${item.bucket}|${item.key}`));
		for (const folder of picked.emptyFolders) {
			const key = folderKey(prefix, folder);
			if (!key || seen.has(`${bucket}|${key}`)) continue;
			seen.add(`${bucket}|${key}`);
			added.push(new UploadItem(this.#nextId++, bucket, key, null));
		}
		for (const { file, path } of picked.files) {
			const key = uploadKey(prefix, path);
			if (!key || seen.has(`${bucket}|${key}`)) continue;
			seen.add(`${bucket}|${key}`);
			const item = new UploadItem(this.#nextId++, bucket, key, file);
			if (key.length > 1024) {
				item.status = 'failed';
				item.error = 'The object key is longer than 1024 characters.';
			} else if (file.size > max) {
				item.status = 'failed';
				item.error = `Larger than the ${formatBytes(max)} dashboard limit. Use the CLI or a presigned upload.`;
			}
			added.push(item);
		}
		if (added.length === 0) return 0;
		// A fresh batch after everything finished starts with a clean list.
		this.items = this.running ? [...this.items, ...added] : added;
		this.#pump();
		// A batch that failed validation entirely never starts, so it never drains on its own.
		if (!this.running) this.#drained();
		return added.length;
	}

	cancel(item: UploadItem): void {
		if (item.finished) return;
		const wasUploading = item.status === 'uploading';
		item.status = 'cancelled';
		item.xhr?.abort();
		if (!wasUploading) this.#checkDrained();
	}

	cancelAll(): void {
		for (const item of this.items) this.cancel(item);
	}

	retry(item: UploadItem): void {
		if (item.status !== 'failed' && item.status !== 'cancelled') return;
		if (item.file && item.file.size > this.#options.maxBytes()) return;
		item.status = 'queued';
		item.error = null;
		item.loaded = 0;
		this.#pump();
	}

	retryFailed(): void {
		for (const item of this.items) if (item.status === 'failed') this.retry(item);
	}

	clear(): void {
		this.items = this.items.filter((item) => !item.finished);
	}

	#pump(): void {
		while (this.#active < this.concurrency) {
			const next = this.items.find((item) => item.status === 'queued');
			if (!next) return;
			this.#active += 1;
			next.status = 'uploading';
			void this.#run(next).finally(() => {
				this.#active -= 1;
				this.#scheduleProgress();
				this.#pump();
				this.#checkDrained();
			});
		}
	}

	#checkDrained(): void {
		if (this.#active === 0 && !this.items.some((item) => item.status === 'queued')) this.#drained();
	}

	#drained(): void {
		if (this.#progressTimer) clearTimeout(this.#progressTimer);
		this.#progressTimer = null;
		const { done, failed, cancelled } = this.counts;
		this.#options.onDrained({ done, failed, cancelled });
	}

	#scheduleProgress(): void {
		if (this.#progressTimer) return;
		this.#progressTimer = setTimeout(() => {
			this.#progressTimer = null;
			if (this.running) this.#options.onProgress();
		}, 1500);
	}

	#url(item: UploadItem, path: 'item' | 'folder'): string {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-off string builder
		const params = new URLSearchParams({ bucket: item.bucket });
		if (path === 'item') params.set('key', item.key);
		return `/api/v1/storage/${encodeURIComponent(this.#options.storage())}/objects/${path}?${params.toString()}`;
	}

	async #run(item: UploadItem): Promise<void> {
		if (item.kind === 'folder') {
			try {
				const response = await fetch(this.#url(item, 'folder'), {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ prefix: item.key })
				});
				if (item.status !== 'uploading') return;
				if (response.ok) item.status = 'done';
				else {
					item.status = 'failed';
					item.error = errorMessage(response.status, await response.text());
				}
			} catch {
				if (item.status === 'uploading') {
					item.status = 'failed';
					item.error = 'Network error.';
				}
			}
			return;
		}

		await new Promise<void>((resolve) => {
			const xhr = new XMLHttpRequest();
			item.xhr = xhr;
			xhr.open('PUT', this.#url(item, 'item'));
			xhr.setRequestHeader('content-type', item.file!.type || 'application/octet-stream');
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) item.loaded = Math.min(event.loaded, item.size);
			};
			xhr.onload = () => {
				if (item.status !== 'uploading') return resolve();
				if (xhr.status >= 200 && xhr.status < 300) {
					item.loaded = item.size;
					item.status = 'done';
				} else {
					item.status = 'failed';
					item.error = errorMessage(xhr.status, xhr.responseText);
				}
				resolve();
			};
			xhr.onerror = () => {
				if (item.status === 'uploading') {
					item.status = 'failed';
					item.error = 'Network error.';
				}
				resolve();
			};
			xhr.onabort = () => resolve();
			xhr.send(item.file);
		});
		item.xhr = null;
	}
}
