import { and, eq, isNull } from 'drizzle-orm';
import { brokerAttachments, brokers } from '@yoal/db';
import type { FunctionRuntimeBinding } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import type { ProjectRow } from '../projects.ts';
import type { BindingResolver } from './types.ts';

/**
 * The managed broker a queue lives on, and the project's attachment prefix for it (D112).
 *
 * `name` names a broker; omitted, the project's only attached broker is used. The attachment is
 * what puts `<PREFIX>_PORT/_USER/_PASSWORD` in the function's activation env, which both the
 * producer service in workerd and the agent's consumer read, so a queue without one is refused
 * at deploy time rather than failing on the node.
 */
export function resolveQueueBroker(
	core: CoreContext,
	project: ProjectRow,
	name: string | undefined,
	label: string,
): { broker: string; envPrefix: string } {
	const attached = core.db
		.select({ broker: brokers.name, envPrefix: brokerAttachments.envPrefix })
		.from(brokerAttachments)
		.innerJoin(brokers, eq(brokers.id, brokerAttachments.brokerId))
		.where(and(eq(brokerAttachments.projectId, project.id), isNull(brokers.deletedAt)))
		.all();
	if (name) {
		const match = attached.find((item) => item.broker === name);
		if (match) return match;
		const exists = core.db
			.select({ id: brokers.id })
			.from(brokers)
			.where(and(eq(brokers.orgId, project.orgId), eq(brokers.name, name), isNull(brokers.deletedAt)))
			.get();
		throw new ValidationError(
			exists
				? `${label}: attach broker "${name}" to "${project.slug}" before using it for queues (yoal broker attach ${name} --project ${project.slug}).`
				: `${label}: broker "${name}" does not exist in this organisation. Create it with yoal broker create ${name} --project ${project.slug}.`,
		);
	}
	if (attached.length === 1) return attached[0]!;
	throw new ValidationError(
		attached.length === 0
			? `${label}: queues run on a managed broker. Create and attach one (yoal broker create <name> --project ${project.slug}) and deploy again.`
			: `${label}: "${project.slug}" has ${attached.length} brokers attached (${attached.map((item) => item.broker).join(', ')}); name one with yoal.brokers in wrangler config.`,
	);
}

/**
 * Resolve a queue producer binding (docs/FUNCTIONS.md §4.5, D112). The queue is a JetStream stream
 * on the broker, shared by every project attached to it, so a producer in one function and a
 * consumer in another meet on the same queue name.
 */
export const resolveQueueBinding: BindingResolver = (context, binding) => {
	if (binding.type !== 'queue')
		throw new Error(`Queue resolver received binding "${binding.name}" of type "${binding.type}", not "queue".`);
	const { broker, envPrefix } = resolveQueueBroker(context.core, context.project, binding.broker, `Binding ${binding.name}`);
	return {
		name: binding.name,
		type: 'queue',
		queue: binding.queue,
		producer: binding.producer ?? true,
		broker,
		envPrefix,
	} satisfies FunctionRuntimeBinding;
};
