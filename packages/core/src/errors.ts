export class CoreError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = 'CoreError';
		this.code = code;
		this.status = status;
	}
}

export class NotFoundError extends CoreError {
	constructor(what: string) {
		super('not_found', `${what} not found`, 404);
	}
}

export class ConflictError extends CoreError {
	constructor(message: string, readonly suggestions: string[] = []) {
		super('conflict', message, 409);
	}
}

export class ValidationError extends CoreError {
	constructor(message: string, readonly issues: unknown[] = []) {
		super('validation', message, 422);
	}
}

export class QuotaError extends CoreError {
	constructor(message: string) {
		super('quota_exceeded', message, 409);
	}
}

export class UnauthorizedError extends CoreError {
	constructor(message = 'Authentication required') {
		super('unauthorized', message, 401);
	}
}

export class RateLimitError extends CoreError {
	constructor(message: string) {
		super('rate_limited', message, 429);
	}
}

export class ForbiddenError extends CoreError {
	constructor(
		readonly permission: string,
		readonly reason?: string,
		readonly via?: string,
	) {
		super(
			'forbidden',
			`Missing permission ${permission}${reason ? ` (${reason})` : ''}`,
			403,
		);
	}
}
