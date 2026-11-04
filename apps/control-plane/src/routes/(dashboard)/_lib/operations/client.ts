import type {
	ItemStatus,
	ItemVerdict,
	OperationCreate,
	OperationItemView,
	OperationView,
	PruneCategory
} from '@skiff/contracts';

/**
 * Browser helpers for the operations REST + SSE endpoints (docs/OPERATIONS.md §6.1, §2.5).
 * The dashboard session cookie authenticates these; mutations are same-origin `fetch`es, which
 * is what the CSRF check expects.
 */
const BASE = '/api/v1/operations';

/** Passing this as `after` asks the stream for progress only, no item events. */
const NO_ITEMS = Number.MAX_SAFE_INTEGER;

export class OperationRequestError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			credentials: 'same-origin',
			headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers }
		});
	} catch {
		throw new OperationRequestError('Network error. Check your connection and try again.', 0);
	}
	const body = (await response.json().catch(() => null)) as
		(Record<string, unknown> & { message?: string; issues?: Array<{ message?: string }> }) | null;
	if (!response.ok) {
		const message =
			(typeof body?.message === 'string' && body.message) ||
			body?.issues?.[0]?.message ||
			`The request failed (${response.status}).`;
		throw new OperationRequestError(message, response.status);
	}
	return body as T;
}

const post = <T>(path: string, body: unknown = {}) =>
	request<T>(path, { method: 'POST', body: JSON.stringify(body) });

/** Create an operation. `waitSeconds` lets the server hold the response until it is planned. */
export function createOperation(input: OperationCreate, waitSeconds = 0): Promise<OperationView> {
	return post<OperationView>(waitSeconds ? `${BASE}?wait=${waitSeconds}` : BASE, input);
}

export async function getOperation(id: string): Promise<OperationView> {
	const body = await request<{ operation: OperationView }>(`${BASE}/${encodeURIComponent(id)}`);
	return body.operation;
}

export interface ItemPage {
	operation: OperationView;
	items: OperationItemView[];
	cursor: number;
	hasMore: boolean;
}

export function listItems(
	id: string,
	options: {
		after?: number;
		limit?: number;
		status?: ItemStatus;
		verdict?: ItemVerdict;
		category?: PruneCategory;
	} = {}
): Promise<ItemPage> {
	const params = new URLSearchParams({ items: '1' });
	for (const [key, value] of Object.entries(options))
		if (value !== undefined) params.set(key, String(value));
	return request<ItemPage>(`${BASE}/${encodeURIComponent(id)}?${params}`);
}

export function applyOperation(id: string, categories?: PruneCategory[]): Promise<OperationView> {
	return post<OperationView>(
		`${BASE}/${encodeURIComponent(id)}/apply`,
		categories ? { categories } : {}
	);
}

export function cancelOperation(id: string): Promise<OperationView> {
	return post<OperationView>(`${BASE}/${encodeURIComponent(id)}/cancel`);
}

export interface StreamHandlers {
	onProgress?: (operation: OperationView) => void;
	onItems?: (items: OperationItemView[], cursor: number) => void;
	onDone: (operation: OperationView) => void;
	onError: (message: string) => void;
}

/**
 * Follow an operation over SSE. By default the stream ends at `planned`; `untilDone` keeps it
 * open through apply. Returns a function that closes the stream.
 */
export function streamOperation(
	id: string,
	handlers: StreamHandlers,
	options: { untilDone?: boolean; items?: boolean } = {}
): () => void {
	const params = new URLSearchParams();
	if (options.untilDone) params.set('until', 'done');
	if (options.items === false) params.set('after', String(NO_ITEMS));
	const query = params.toString() ? `?${params}` : '';
	const source = new EventSource(`${BASE}/${encodeURIComponent(id)}/stream${query}`);
	let closed = false;
	const close = () => {
		closed = true;
		source.close();
	};
	const parse = (event: Event): unknown => {
		try {
			return JSON.parse((event as MessageEvent<string>).data);
		} catch {
			return null;
		}
	};

	source.addEventListener('progress', (event) => {
		const operation = parse(event) as OperationView | null;
		if (!closed && operation) handlers.onProgress?.(operation);
	});
	source.addEventListener('items', (event) => {
		const data = parse(event) as { items?: OperationItemView[]; cursor?: number } | null;
		if (!closed && Array.isArray(data?.items)) handlers.onItems?.(data.items, data.cursor ?? 0);
	});
	source.addEventListener('done', (event) => {
		if (closed) return;
		close();
		const operation = parse(event) as OperationView | null;
		if (operation) handlers.onDone(operation);
		else handlers.onError('The progress stream ended unexpectedly.');
	});
	source.addEventListener('server-error', (event) => {
		if (closed) return;
		close();
		const data = parse(event) as { message?: string } | null;
		handlers.onError(data?.message ?? 'The progress stream failed.');
	});
	source.onerror = () => {
		// EventSource retries on its own while CONNECTING; CLOSED means it gave up (e.g. 4xx).
		if (closed || source.readyState !== EventSource.CLOSED) return;
		closed = true;
		handlers.onError('Lost the progress stream. Reload the page to see the latest state.');
	};
	return close;
}

/** Resolve once an operation stops planning (planned, or finished early). */
export function waitForPlan(id: string): Promise<OperationView> {
	return new Promise((resolve, reject) => {
		streamOperation(
			id,
			{
				onDone: resolve,
				onError: (message) => reject(new OperationRequestError(message, 0))
			},
			{ items: false }
		);
	});
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return 'That did not work. Please try again.';
}
