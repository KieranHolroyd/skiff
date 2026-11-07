import {
	CLUSTER_CONFIG_KEY,
	canAdministerPlatform,
	canViewPlatform,
	clusterConfigSchema,
	clusterConfigUpdateSchema,
	type ClusterConfig,
	type ClusterConfigUpdate,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, ValidationError } from './errors.ts';

/**
 * Cluster configuration (Settings → Clustering). One settings row, cached and re-read on save.
 * Platform-wide: platform admins read it (`view`), and only a platform admin's own dashboard
 * session changes it (`update`; API keys and OAuth tokens never carry platform scope, D107).
 * `get()` is the unchecked internal read the scheduler, nodes and replicas use.
 */
export class ClusterConfigService {
	#cache: ClusterConfig | null = null;

	constructor(private readonly ctx: CoreContext) {}

	get(): ClusterConfig {
		if (this.#cache) return this.#cache;
		let raw: unknown = {};
		try {
			const row = this.ctx.sqlite
				.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
				.get(CLUSTER_CONFIG_KEY);
			if (row) raw = JSON.parse(row.value);
		} catch {
			// First boot or a hand-edited row: defaults are the documented behaviour.
		}
		this.#cache = clusterConfigSchema.parse({
			overlay: {},
			endpoints: {},
			replicas: {},
			database: {},
			storage: {},
			controlPlane: {},
			failover: {},
			shares: {},
			...(raw && typeof raw === 'object' ? raw : {}),
		});
		return this.#cache;
	}

	/** The configuration for a surface: platform admins only. */
	view(principal: Principal): ClusterConfig {
		if (!canViewPlatform(principal))
			throw new CoreError('forbidden', 'Only a platform admin can read the cluster configuration.', 403);
		return this.get();
	}

	update(principal: Principal, input: unknown): ClusterConfig {
		if (!canAdministerPlatform(principal))
			throw new CoreError(
				'forbidden',
				'Only a platform admin signed in to the dashboard can change the cluster configuration.',
				403,
			);
		const patch = clusterConfigUpdateSchema.safeParse(input);
		if (!patch.success) throw new ValidationError('Invalid cluster configuration.', patch.error.issues);
		const current = this.get();
		if (
			(patch.data.endpoints?.portMin ?? current.endpoints.portMin) >=
			(patch.data.endpoints?.portMax ?? current.endpoints.portMax)
		)
			throw new ValidationError('The endpoint port range must have min < max.');
		const merged = clusterConfigSchema.safeParse({
			...current,
			...patch.data,
			overlay: { ...current.overlay, ...patch.data.overlay },
			endpoints: { ...current.endpoints, ...patch.data.endpoints },
			replicas: { ...current.replicas, ...patch.data.replicas },
			database: { ...current.database, ...patch.data.database },
			storage: { ...current.storage, ...patch.data.storage },
			controlPlane: { ...current.controlPlane, ...patch.data.controlPlane },
			failover: { ...current.failover, ...patch.data.failover },
			shares: { ...current.shares, ...patch.data.shares },
		});
		if (!merged.success) throw new ValidationError('Invalid cluster configuration.', merged.error.issues);
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[CLUSTER_CONFIG_KEY, JSON.stringify(merged.data), this.ctx.now()],
		);
		this.#cache = merged.data;
		// The edge's health-check interval is in every replicated route: re-render desired state.
		if (merged.data.replicas.healthIntervalSeconds !== current.replicas.healthIntervalSeconds) this.ctx.projects.bump();
		this.ctx.audit.record({
			principal,
			action: 'platform.cluster_config',
			resource: 'platform',
			resourceId: 'cluster',
			args: patch.data as ClusterConfigUpdate,
			result: 'ok',
		});
		return merged.data;
	}
}
