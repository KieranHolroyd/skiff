import { canViewPlatform, type IngressDriver, type Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError } from './errors.ts';

/** Ingress HA status (docs/CLUSTERING.md §7, C5). */
export interface IngressStatus {
	driver: IngressDriver;
	policy: { holdDownSeconds: number; readdSeconds: number };
	nodes: Array<{ id: string; name: string; zone: string; status: string; ready: boolean }>;
}

export class IngressHaService {
	constructor(private readonly ctx: CoreContext) {}

	status(principal: Principal): IngressStatus {
		if (!canViewPlatform(principal)) throw new CoreError('forbidden', 'Platform admin required.', 403);
		const policies = this.ctx.policies.get();
		return {
			driver: policies.ingressDriver,
			policy: { holdDownSeconds: policies.ingressHoldDownSeconds, readdSeconds: policies.ingressReaddSeconds },
			nodes: this.ctx.nodes
				.list(principal)
				.filter((node) => node.roles.includes('ingress'))
				.map((node) => ({
					id: node.id,
					name: node.name,
					zone: node.zone,
					status: node.status,
					ready: node.status === 'online',
				})),
		};
	}
}
