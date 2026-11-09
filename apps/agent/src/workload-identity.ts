import { timingSafeEqual } from 'node:crypto';
import {
	WORKLOAD_IDENTITY_AUDIENCE,
	WORKLOAD_IDENTITY_PORT,
	workloadIdentityResponseSchema,
	type WorkloadDesired,
	type WorkloadIdentityActivation,
	type WorkloadIdentityResponse,
} from '@skiff/contracts';

/**
 * The agent's workload-identity broker (docs/IAM.md I18, §7.4).
 *
 * It holds the token the control plane put in an activation, hands it to the helper (the only
 * process that writes `/run/skiff/identity/<workload>/token`), refreshes it at 50% of its
 * lifetime, and serves `GET /identity/token?audience=…` on loopback. The metadata endpoint is how
 * a workload asks for an audience other than Skiff (`sts.amazonaws.com`, …) and how a process app
 * refreshes a token after its startup credential has expired.
 *
 * A workload proves itself with the activation token it already has. That token is matched against
 * the broker's in-memory set, never parsed or trusted from the request: the control plane is the
 * only issuer, and a leaked expired token still only buys a token for that same workload.
 */

export interface HeldWorkloadIdentity {
	token: string;
	expiresAt: number;
	issuedAt: number;
}

export interface WorkloadIdentityMinter {
	(workloadId: string, audience: string, signal?: AbortSignal): Promise<WorkloadIdentityResponse>;
}

export interface WorkloadIdentityHelper {
	setIdentity?(id: string, token: string): Promise<void>;
}

export type WorkloadIdentityLog = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface WorkloadIdentityBrokerOptions {
	mint: WorkloadIdentityMinter;
	helper: WorkloadIdentityHelper;
	log?: WorkloadIdentityLog;
	now?: () => number;
	/** Fixed loopback port; the function analytics sink uses 8085. */
	port?: number;
}

const MAX_AUDIENCE = 512;

export class WorkloadIdentityBroker {
	private readonly mint: WorkloadIdentityMinter;
	private readonly helper: WorkloadIdentityHelper;
	private readonly log: WorkloadIdentityLog;
	private readonly now: () => number;
	private readonly port: number;
	private readonly held = new Map<string, HeldWorkloadIdentity>();
	private server: ReturnType<typeof Bun.serve> | null = null;
	/** One refresh pass at a time; the reconcile loop and a metadata request can race. */
	private refreshing: Promise<void> | null = null;

	constructor(options: WorkloadIdentityBrokerOptions) {
		this.mint = options.mint;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? (() => Date.now());
		this.port = options.port ?? WORKLOAD_IDENTITY_PORT;
	}

	/** Remember the token an activation carried. The helper already wrote its file. */
	hold(workloadId: string, identity: WorkloadIdentityActivation): void {
		const issuedAt = this.now();
		this.held.set(workloadId, {
			token: identity.token,
			issuedAt,
			expiresAt: issuedAt + identity.expiresIn * 1_000,
		});
	}

	forget(workloadId: string): void {
		this.held.delete(workloadId);
	}

	/** Drop workloads that left desired state (their helper file is removed with the unit). */
	retain(workloadIds: ReadonlySet<string>): void {
		for (const id of [...this.held.keys()]) if (!workloadIds.has(id)) this.held.delete(id);
	}

	token(workloadId: string): string | null {
		return this.held.get(workloadId)?.token ?? null;
	}

	/** True when the token is past half its lifetime, or gone. */
	needsRefresh(workloadId: string, now = this.now()): boolean {
		const held = this.held.get(workloadId);
		if (!held) return true;
		return now >= held.issuedAt + (held.expiresAt - held.issuedAt) / 2;
	}

	/**
	 * Refresh every due workload in a desired set, and recover tokens after an agent restart (the
	 * activation was not fetched again, but the workload's file may still be on disk). A failure is
	 * logged and leaves the previous token in place; the next pass retries.
	 */
	async refresh(workloads: readonly WorkloadDesired[], signal: AbortSignal): Promise<void> {
		const due = workloads.filter((workload) => workload.identity && this.needsRefresh(workload.id));
		if (due.length === 0) return;
		this.refreshing ??= (async () => {
			try {
				for (const workload of due) {
					if (signal.aborted) return;
					try {
						const response = await this.mint(workload.id, WORKLOAD_IDENTITY_AUDIENCE, signal);
						const issuedAt = this.now();
						this.held.set(workload.id, {
							token: response.access_token,
							issuedAt,
							expiresAt: issuedAt + response.expires_in * 1_000,
						});
						// The helper owns the 0400 file and preserves its owner (a container's `:U`
						// hand-over). An older helper returns 404; the metadata endpoint still works.
						try {
							await this.helper.setIdentity?.(workload.id, response.access_token);
						} catch (error) {
							this.log(
								'warn',
								`Could not write the identity file for ${workload.id}: ${errorText(error)}`,
							);
						}
					} catch (error) {
						if (signal.aborted) return;
						this.log(
							'warn',
							`Could not refresh the identity token for ${workload.id}: ${errorText(error)}`,
						);
					}
				}
			} finally {
				this.refreshing = null;
			}
		})();
		await this.refreshing;
	}

	/** Start the loopback metadata endpoint. A bind failure is logged, never fatal. */
	start(): void {
		if (this.server) return;
		try {
			this.server = Bun.serve({
				hostname: '127.0.0.1',
				port: this.port,
				fetch: (request) => this.handle(request),
			});
			this.log('info', `Workload identity metadata listening on 127.0.0.1:${this.port}`);
		} catch (error) {
			this.log('warn', `Workload identity metadata unavailable: ${errorText(error)}`);
		}
	}

	stop(): void {
		this.server?.stop(true);
		this.server = null;
	}

	/** `GET /identity/token?audience=…`; any other path is a 404, never a proxy. */
	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/identity/token') return json({ error: 'not_found' }, 404);
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

		const token = bearer(request.headers.get('authorization'));
		if (!token) return json({ error: 'unauthorized' }, 401);
		const workloadId = this.authenticate(token);
		if (!workloadId) return json({ error: 'unauthorized' }, 401);

		const audience = (url.searchParams.get('audience')?.trim() || WORKLOAD_IDENTITY_AUDIENCE).slice(
			0,
			MAX_AUDIENCE,
		);
		if (!audience || /[\u0000-\u001f\u007f]/.test(audience))
			return json({ error: 'invalid_request' }, 400);

		try {
			if (audience === WORKLOAD_IDENTITY_AUDIENCE) {
				if (this.needsRefresh(workloadId)) await this.refreshOne(workloadId);
				const held = this.held.get(workloadId);
				if (!held || held.expiresAt <= this.now()) return json({ error: 'temporarily_unavailable' }, 503);
				return json(
					{
						access_token: held.token,
						expires_in: Math.max(1, Math.ceil((held.expiresAt - this.now()) / 1_000)),
						token_type: 'Bearer',
					},
					200,
				);
			}
			const response = await this.mint(workloadId, audience);
			return json(response, 200);
		} catch (error) {
			this.log('warn', `Identity token for ${workloadId} (${audience}) failed: ${errorText(error)}`);
			return json({ error: 'temporarily_unavailable' }, 503);
		}
	}

	/** Match a presented activation token to its workload without leaking timing on a prefix. */
	authenticate(presented: string): string | null {
		const wanted = Buffer.from(presented);
		for (const [id, held] of this.held) {
			const candidate = Buffer.from(held.token);
			if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) return id;
		}
		return null;
	}

	private async refreshOne(workloadId: string): Promise<void> {
		const response = await this.mint(workloadId, WORKLOAD_IDENTITY_AUDIENCE);
		const issuedAt = this.now();
		this.held.set(workloadId, {
			token: response.access_token,
			issuedAt,
			expiresAt: issuedAt + response.expires_in * 1_000,
		});
		try {
			await this.helper.setIdentity?.(workloadId, response.access_token);
		} catch (error) {
			this.log('warn', `Could not write the identity file for ${workloadId}: ${errorText(error)}`);
		}
	}
}

/** Parse and validate the control-plane response in one place. */
export function parseIdentityResponse(value: unknown): WorkloadIdentityResponse {
	return workloadIdentityResponseSchema.parse(value);
}

function bearer(header: string | null): string | null {
	if (!header?.startsWith('Bearer ')) return null;
	const token = header.slice(7).trim();
	return token || null;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
