import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shared by the provision and stress scripts. No Skiff imports: the example is a black box. */

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

export interface ApiClientOptions {
	baseUrl: string;
	token: string;
	origin?: string;
	timeoutMs?: number;
}

/** Minimal bearer client for the Skiff REST API (`docs/API.md`). */
export class ApiClient {
	readonly baseUrl: string;
	private readonly token: string;
	private readonly origin: string;
	private readonly timeoutMs: number;

	constructor(options: ApiClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.token = options.token;
		this.origin = options.origin ?? this.baseUrl;
		this.timeoutMs = options.timeoutMs ?? 60_000;
	}

	get<T = unknown>(path: string): Promise<T> {
		return this.request<T>('GET', path);
	}
	post<T = unknown>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('POST', path, body);
	}
	put<T = unknown>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('PUT', path, body);
	}
	patch<T = unknown>(path: string, body?: unknown): Promise<T> {
		return this.request<T>('PATCH', path, body);
	}
	del<T = unknown>(path: string): Promise<T> {
		return this.request<T>('DELETE', path);
	}

	async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.token}`,
			accept: 'application/json',
			origin: this.origin
		};
		if (body !== undefined) headers['content-type'] = 'application/json';
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs)
		});
		const text = await response.text();
		let data: unknown = undefined;
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
		}
		if (!response.ok) {
			throw new ApiError(response.status, apiMessage(response.status, data), data);
		}
		return data as T;
	}
}

function apiMessage(status: number, data: unknown): string {
	if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 500);
	if (data && typeof data === 'object') {
		const record = data as Record<string, unknown>;
		const message = record.message ?? record.error;
		const issues = record.issues;
		if (Array.isArray(issues) && issues.length > 0) {
			const first = issues[0] as Record<string, unknown>;
			const path = Array.isArray(first.path) ? first.path.join('.') : '';
			return `${path ? `${path}: ` : ''}${String(first.message ?? 'validation failed')}`;
		}
		if (typeof message === 'string') return message;
	}
	return `HTTP ${status}`;
}

/** `{ "project": {...} }` and a bare object are both valid across v1/v2 route shapes. */
export function unwrap<T>(data: unknown, key: string): T {
	if (data && typeof data === 'object' && key in data) {
		return (data as Record<string, unknown>)[key] as T;
	}
	return data as T;
}

export function asArray<T>(data: unknown, key: string): T[] {
	if (Array.isArray(data)) return data as T[];
	if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)[key])) {
		return (data as Record<string, unknown>)[key] as T[];
	}
	return [];
}

type FlagType = 'string' | 'boolean';
export type FlagSpec = Record<string, FlagType>;

/** Tiny flag parser: `--key value`, `--key=value`, repeated strings, and `--no-key`. */
export class Flags {
	private readonly values = new Map<string, string | string[] | boolean>();

	constructor(argv: string[], spec: FlagSpec) {
		for (let index = 0; index < argv.length; index += 1) {
			const arg = argv[index]!;
			if (!arg.startsWith('--') || arg === '--') {
				throw new Error(`Unexpected argument "${arg}"`);
			}
			const raw = arg.slice(2);
			const equals = raw.indexOf('=');
			const fullName = equals === -1 ? raw : raw.slice(0, equals);
			let inline = equals === -1 ? undefined : raw.slice(equals + 1);
			let value: string | boolean | undefined;
			let name = fullName;
			let negated = false;
			// A spec may name a flag `no-foo` (a switch) or `foo` (negatable with `--no-foo`).
			let type: FlagType | undefined = spec[fullName];
			if (!type && fullName.startsWith('no-')) {
				name = fullName.slice(3);
				negated = true;
				type = spec[name];
			}
			if (!type) throw new Error(`Unknown flag --${fullName}`);
			if (negated) {
				if (type !== 'boolean') throw new Error(`--no-${name} is only valid for booleans`);
				if (inline !== undefined) throw new Error(`--no-${name} does not take a value`);
				value = false;
			} else if (type === 'boolean') {
				if (inline !== undefined)
					throw new Error(`--${name} does not take a value (use --no-${name})`);
				value = true;
			} else {
				if (inline === undefined) {
					const next = argv[index + 1];
					if (next === undefined || next.startsWith('--')) {
						throw new Error(`--${name} needs a value`);
					}
					inline = next;
					index += 1;
				}
				value = inline;
			}
			const previous = this.values.get(name);
			if (previous !== undefined) {
				if (Array.isArray(previous)) previous.push(String(value));
				else this.values.set(name, [String(previous), String(value)]);
			} else {
				this.values.set(name, value);
			}
		}
	}

	string(name: string): string | undefined {
		const value = this.values.get(name);
		if (Array.isArray(value)) return value[value.length - 1];
		return typeof value === 'string' ? value : undefined;
	}

	list(name: string): string[] {
		const value = this.values.get(name);
		if (value === undefined) return [];
		if (Array.isArray(value)) return value;
		return typeof value === 'string' ? [value] : [];
	}

	has(name: string): boolean {
		return this.values.has(name);
	}

	bool(name: string): boolean {
		const value = this.values.get(name);
		if (Array.isArray(value)) return value[value.length - 1] === 'true';
		return value === true;
	}

	int(
		name: string,
		fallback: number,
		min = Number.MIN_SAFE_INTEGER,
		max = Number.MAX_SAFE_INTEGER
	): number {
		const raw = this.string(name);
		if (raw === undefined) return fallback;
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed)) throw new Error(`--${name} must be an integer`);
		return Math.min(max, Math.max(min, parsed));
	}
}

export interface StressState {
	platform?: string;
	project: string;
	projectId?: string;
	runtime?: string;
	appUrl?: string;
	stagingUrl?: string;
	workloadId?: string;
	deploymentId?: string;
	memoryMb?: number;
	cpus?: number;
	port?: number;
	environment?: string;
	domain?: string;
	gitRepo?: string;
	webhookSecret?: string;
	secretDigests: Record<string, string>;
	updatedAt: string;
}

export function readState(path: string): StressState | null {
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StressState>;
		if (typeof parsed.project !== 'string') return null;
		return {
			...parsed,
			project: parsed.project,
			secretDigests: parsed.secretDigests ?? {},
			updatedAt: parsed.updatedAt ?? new Date(0).toISOString()
		};
	} catch {
		return null;
	}
}

export function writeState(path: string, state: StressState): void {
	const absolute = resolve(path);
	const temporary = `${absolute}.tmp-${process.pid}`;
	const payload = `${JSON.stringify(state, null, 2)}\n`;
	writeFileSync(temporary, payload, { mode: 0o600 });
	renameSync(temporary, absolute);
	chmodSync(absolute, 0o600);
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export function randomSecret(prefix: string): string {
	return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index] ?? 0;
}

export function round(value: number, digits = 1): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function exampleDir(): string {
	return resolve(import.meta.dir, '..');
}

/** Remove ANSI when the output is captured, but keep it pleasant in a terminal. */
export function isInteractive(): boolean {
	return Boolean(process.stdout.isTTY);
}

export function colour(code: string, value: string): string {
	return isInteractive() ? `\u001b[${code}m${value}\u001b[0m` : value;
}

export const green = (value: string): string => colour('32', value);
export const red = (value: string): string => colour('31', value);
export const yellow = (value: string): string => colour('33', value);
export const dim = (value: string): string => colour('2', value);
export const bold = (value: string): string => colour('1', value);
