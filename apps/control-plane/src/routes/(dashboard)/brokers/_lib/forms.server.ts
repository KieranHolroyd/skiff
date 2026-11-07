import { hasPermission, type Principal } from '@skiff/contracts';

/** What the viewer may do with queue brokers; the dashboard hides actions they can't take. */
export function brokerCan(principal: Principal) {
	return {
		create: hasPermission(principal, 'broker:create'),
		update: hasPermission(principal, 'broker:update'),
		delete: hasPermission(principal, 'broker:delete'),
		credentials: hasPermission(principal, 'broker:credentials'),
		/** Attach/detach also changes the project (D56). */
		attach: hasPermission(principal, 'broker:update') && hasPermission(principal, 'project:update')
	};
}

export type BrokerCan = ReturnType<typeof brokerCan>;
