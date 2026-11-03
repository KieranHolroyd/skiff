/**
 * Error types shared by the CLI. Everything thrown intentionally is a `CliError` so
 * `main.ts` can print a clean message and exit 1 instead of dumping a stack trace.
 */

export class CliError extends Error {
	readonly code: string;
	readonly exitCode: number;
	readonly suggestions: string[];
	readonly details?: unknown;

	constructor(
		message: string,
		options: { code?: string; exitCode?: number; suggestions?: string[]; details?: unknown; cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.name = 'CliError';
		this.code = options.code ?? 'error';
		this.exitCode = options.exitCode ?? 1;
		this.suggestions = options.suggestions ?? [];
		this.details = options.details;
	}
}

export class UsageError extends CliError {
	constructor(message: string) {
		super(message, { code: 'usage' });
		this.name = 'UsageError';
	}
}

export class ConfigError extends CliError {
	constructor(message: string, options: { cause?: unknown; suggestions?: string[] } = {}) {
		super(message, { code: 'config', cause: options.cause, suggestions: options.suggestions });
		this.name = 'ConfigError';
	}
}

export class ApiError extends CliError {
	readonly status: number;
	readonly method: string;
	readonly url: string;
	readonly requestId?: string;
	readonly body?: unknown;

	constructor(
		message: string,
		options: {
			status: number;
			method: string;
			url: string;
			code?: string;
			suggestions?: string[];
			requestId?: string;
			body?: unknown;
		},
	) {
		super(message, {
			code: options.code ?? `http_${options.status}`,
			suggestions: options.suggestions,
			details: options.body,
		});
		this.name = 'ApiError';
		this.status = options.status;
		this.method = options.method;
		this.url = options.url;
		this.requestId = options.requestId;
		this.body = options.body;
	}
}
