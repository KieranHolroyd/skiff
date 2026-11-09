import * as Sentry from '@sentry/node';
import type { ServerErrorCapture } from '@yoal/core';
import type { SentryRuntimeStatus } from '@yoal/contracts';
import { core } from './core.js';
import { platformVersion } from './version.js';

/**
 * Optional Sentry forwarding (docs/SERVER-ERRORS.md §6).
 *
 * Everything is configured from Settings → Server errors and stored in the platform database, so
 * turning it on never needs an environment variable, a restart or the root helper. When no DSN is
 * saved this module is inert; the built-in tracker keeps working either way.
 *
 * Events go through the same capture path as the local tracker: `server-errors.ts` hands each
 * `ServerErrorCapture` to `forwardServerError`. It never carries a request body, header or cookie,
 * and `sendDefaultPii` is off unless an operator opts in.
 */

const runtime: SentryRuntimeStatus & { eventsSent: number } = {
	active: false,
	eventsSent: 0,
	lastEventAt: null,
	lastError: null
};

let appliedKey: string | null = null;
let reconfiguring: Promise<SentryRuntimeStatus> | null = null;
/** A disabled install reads the config at most this often while errors arrive. */
let lastDisabledCheck = 0;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function keyOf(config: NonNullable<ReturnType<typeof core.sentry.config>>): string {
	return JSON.stringify({
		enabled: config.enabled,
		dsn: config.dsn,
		environment: config.environment,
		release: config.release,
		tracesSampleRate: config.tracesSampleRate,
		sendDefaultPii: config.sendDefaultPii,
		token: config.authToken ? 'set' : 'unset',
		organization: config.organizationSlug,
		project: config.projectSlug
	});
}

/** `https://key@o123.ingest.sentry.io/456` → `https://sentry.io`; self-hosted keeps its origin. */
function apiBase(dsn: string): string {
	const url = new URL(dsn);
	if (/(^|\.)ingest\.sentry\.io$/i.test(url.hostname) || /(^|\.)sentry\.io$/i.test(url.hostname))
		return 'https://sentry.io';
	return `${url.protocol}//${url.host}`;
}

function releaseName(): string {
	const config = core.sentry.config();
	return config?.release?.trim() || `yoal@${platformVersion}`;
}

/** Best effort: tell Sentry a release exists so issues can be grouped by it. */
async function publishRelease(config: NonNullable<ReturnType<typeof core.sentry.config>>): Promise<void> {
	if (!config.authToken || !config.organizationSlug || !config.projectSlug) return;
	try {
		const version = config.release?.trim() || `yoal@${platformVersion}`;
		const response = await fetch(
			`${apiBase(config.dsn!)}/api/0/projects/${encodeURIComponent(config.organizationSlug)}/${encodeURIComponent(config.projectSlug)}/releases/`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${config.authToken}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ version, projects: [config.projectSlug] }),
				signal: AbortSignal.timeout(10_000)
			}
		);
		// 409 means the release already exists, which is exactly what we want.
		if (!response.ok && response.status !== 409) {
			runtime.lastError = `Sentry release: HTTP ${response.status} ${(await response.text()).slice(0, 160)}`;
		}
	} catch (error) {
		runtime.lastError = `Sentry release: ${message(error).slice(0, 200)}`;
	}
}

async function apply(): Promise<SentryRuntimeStatus> {
	const config = core.sentry.config();
	if (!config?.enabled || !config.dsn) {
		if (Sentry.getClient()) await Sentry.close(2_000);
		appliedKey = null;
		runtime.active = false;
		return { ...runtime };
	}
	const key = keyOf(config);
	if (key === appliedKey && Sentry.getClient()) {
		runtime.active = true;
		return { ...runtime };
	}
	try {
		if (Sentry.getClient()) await Sentry.close(2_000);
		Sentry.init({
			dsn: config.dsn,
			environment: config.environment,
			release: config.release?.trim() || `yoal@${platformVersion}`,
			tracesSampleRate: config.tracesSampleRate,
			// Request bodies are never sent. Headers, cookies and query strings are off unless the
			// operator explicitly asked for request metadata; even then only a small allowlist goes.
			dataCollection: config.sendDefaultPii
				? {
						userInfo: true,
						cookies: false,
						httpHeaders: { request: { allow: ['user-agent', 'referer', 'content-type'] }, response: false },
						httpBodies: [],
						urlQueryParams: false,
						databaseQueryData: false
					}
				: {
						userInfo: true,
						cookies: false,
						httpHeaders: false,
						httpBodies: [],
						urlQueryParams: false,
						databaseQueryData: false,
						queues: false,
						stackFrameVariables: false,
						graphQL: { document: false, variables: false },
						genAI: { inputs: false, outputs: false },
						mcp: { inputs: false, outputs: false }
					},
			initialScope: { tags: { service: 'yoal-control-plane' } }
		});
		appliedKey = key;
		runtime.active = true;
		runtime.lastError = null;
		void publishRelease(config);
	} catch (error) {
		appliedKey = null;
		runtime.active = false;
		runtime.lastError = message(error).slice(0, 300);
	}
	return { ...runtime };
}

/** Initialise from the saved config (boot, and after Settings saves it). Safe to call often. */
export function reconfigureSentry(): Promise<SentryRuntimeStatus> {
	if (!reconfiguring) {
		reconfiguring = apply().finally(() => {
			reconfiguring = null;
		});
	}
	return reconfiguring;
}

export function sentryRuntime(): SentryRuntimeStatus {
	return { ...runtime, eventsSent: runtime.eventsSent };
}

/** Called by `server-errors.ts` for every capture. Fire-and-forget and never throws. */
export function forwardServerError(capture: ServerErrorCapture): void {
	void (async () => {
		try {
			if (!runtime.active) {
				if (Date.now() - lastDisabledCheck < 5_000) return;
				lastDisabledCheck = Date.now();
				await reconfigureSentry();
			}
			if (!Sentry.getClient()) return;
			Sentry.withScope((scope) => {
				scope.setTag('yoal.source', capture.source);
				scope.setTag('yoal.status', String(capture.status ?? 500));
				if (capture.culprit) scope.setTag('yoal.culprit', capture.culprit);
				if (capture.routeId) scope.setTag('yoal.route', capture.routeId);
				if (capture.orgId) scope.setTag('yoal.org', capture.orgId);
				if (capture.userId) scope.setUser({ id: capture.userId });
				scope.setContext('yoal', {
					source: capture.source,
					method: capture.method ?? null,
					path: capture.path ?? null,
					routeId: capture.routeId ?? null,
					status: capture.status ?? null,
					...(capture.context ?? {})
				});
				const eventId =
					capture.error instanceof Error
						? Sentry.captureException(capture.error)
						: Sentry.captureException(
								Object.assign(new Error(capture.message ?? capture.name ?? 'Unknown error'), {
									name: capture.name ?? 'NonErrorThrown'
								})
							);
				if (eventId) {
					runtime.eventsSent += 1;
					runtime.lastEventAt = new Date().toISOString();
				}
			});
			// A short flush keeps an event from being lost when the process is stopping.
			await Sentry.flush(2_000);
		} catch (error) {
			runtime.lastError = message(error).slice(0, 300);
		}
	})();
}

/** Settings → "Send a test event". Uses the saved config; the caller checks permission. */
export async function sendSentryTest(): Promise<
	{ ok: true; eventId: string | null; release: string } | { ok: false; error: string }
> {
	const config = core.sentry.config();
	if (!config?.dsn) return { ok: false, error: 'Save a Sentry DSN first.' };
	if (!config.enabled) return { ok: false, error: 'Turn Sentry forwarding on first.' };
	await reconfigureSentry();
	if (!Sentry.getClient())
		return { ok: false, error: runtime.lastError ?? 'Sentry could not be initialised.' };
	try {
		const eventId = Sentry.captureMessage(
			'Yoal test event: Sentry is connected to the control plane.',
			'info'
		);
		await Sentry.flush(5_000);
		if (eventId) {
			runtime.eventsSent += 1;
			runtime.lastEventAt = new Date().toISOString();
		}
		return { ok: true, eventId: eventId ?? null, release: releaseName() };
	} catch (error) {
		return { ok: false, error: message(error).slice(0, 300) };
	}
}
