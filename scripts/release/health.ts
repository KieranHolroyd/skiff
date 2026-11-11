/**
 * Control-plane health probes over a unix socket. Shared by the release hook (canary) and the
 * stage-0 updater (live checks), so both judge "healthy" the same way.
 *
 * Every probe returns *why* it failed, not just false: the reason is what reaches the dashboard
 * when an update is refused (the 2026-11-05 incident surfaced systemd noise instead of the
 * `/readyz` body that named the problem).
 */

export interface Probe {
	ok: boolean;
	/** One human-readable line; set when !ok. */
	reason?: string;
	/** Waiting longer cannot help (the process is gone); stop polling now. */
	fatal?: boolean;
}

export interface ProbeOptions {
	/** Public origin (e.g. https://control.example.com); used for the Host / X-Forwarded-* headers. */
	origin?: string | null;
}

function headersFor(origin: string | null | undefined): Record<string, string> {
	const host = new URL(origin || 'http://localhost').host;
	return { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': host };
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as { code?: string }).code;
		if (code === 'FailedToOpenSocket' || code === 'ENOENT' || code === 'ECONNREFUSED') return 'socket is not accepting connections';
		if (error.name === 'TimeoutError') return 'timed out';
		return code ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

/**
 * `/api/setup/status` returns the setup JSON (the app booted and can query SQLite) and `/login`
 * renders without a server error (SSR works). Both requests are sent together: they are
 * independent, and health polls wait on them several times per update.
 */
export async function socketHealthy(socket: string, options: ProbeOptions = {}): Promise<Probe> {
	const headers = headersFor(options.origin);
	const loginPromise = fetch('http://localhost/login', {
		unix: socket,
		headers,
		redirect: 'manual',
		signal: AbortSignal.timeout(5_000),
	});
	// The status check may decide the verdict first; never leave the login request unhandled.
	loginPromise.catch(() => undefined);
	try {
		const status = await fetch('http://localhost/api/setup/status', {
			unix: socket,
			headers,
			signal: AbortSignal.timeout(3_000),
		});
		if (status.status !== 200) {
			await status.arrayBuffer().catch(() => undefined);
			void loginPromise.then((login) => login.arrayBuffer()).catch(() => undefined);
			return { ok: false, reason: `/api/setup/status answered ${status.status}` };
		}
		const body = (await status.json()) as { needsSetup?: unknown };
		if (typeof body.needsSetup !== 'boolean') {
			void loginPromise.then((login) => login.arrayBuffer()).catch(() => undefined);
			return { ok: false, reason: '/api/setup/status returned an unexpected body' };
		}
		const login = await loginPromise;
		await login.arrayBuffer();
		if (login.status >= 500) return { ok: false, reason: `/login answered ${login.status}` };
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: describeError(error) };
	}
}

interface ReadyzBody {
	ok?: unknown;
	checks?: { id?: string; status?: string; message?: string }[];
}

/**
 * One `/readyz` probe. A release from before the endpoint existed (404) falls back to
 * {@link socketHealthy} so a forced downgrade stays checkable. On 503 the failing checks'
 * messages become the reason.
 */
export async function readyzOnce(socket: string, options: ProbeOptions = {}): Promise<Probe> {
	try {
		const response = await fetch('http://localhost/readyz', {
			unix: socket,
			headers: headersFor(options.origin),
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status === 404) {
			await response.arrayBuffer().catch(() => undefined);
			return socketHealthy(socket, options);
		}
		const text = await response.text();
		let body: ReadyzBody | null = null;
		try {
			body = JSON.parse(text) as ReadyzBody;
		} catch {
			body = null;
		}
		if (response.status === 200 && body?.ok === true) return { ok: true };
		const failing = (body?.checks ?? []).filter((check) => check.status === 'error').map((check) => check.message || check.id);
		return {
			ok: false,
			reason: failing.length
				? `/readyz: ${failing.join('; ')}`
				: `/readyz answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
		};
	} catch (error) {
		return { ok: false, reason: describeError(error) };
	}
}

/** Both probes must pass: the setup/login smoke test and `/readyz`. They run side by side. */
export async function fullyHealthy(socket: string, options: ProbeOptions = {}): Promise<Probe> {
	const [smoke, ready] = await Promise.all([socketHealthy(socket, options), readyzOnce(socket, options)]);
	return smoke.ok ? ready : smoke;
}

/**
 * Poll `check` until it passes or `timeoutMs` elapses. Resolves with the last probe, so a
 * timeout still says what was wrong. A check that throws stops the poll (e.g. "unit exited").
 *
 * Four checks a second: a release that boots in 1.7 s should not wait until 2.0 s to be noticed,
 * and a probe is a local socket request (plus one `systemctl is-active` in the canary).
 */
export async function pollProbe(
	check: () => Promise<Probe>,
	timeoutMs: number,
	everyMs = 250,
): Promise<Probe> {
	const deadline = Date.now() + timeoutMs;
	let last: Probe = { ok: false, reason: 'not checked yet' };
	for (;;) {
		last = await check();
		if (last.ok || last.fatal) return last;
		if (Date.now() + everyMs > deadline) return { ok: false, reason: `${last.reason ?? 'unhealthy'} (after ${Math.round(timeoutMs / 1000)}s)` };
		await Bun.sleep(everyMs);
	}
}
