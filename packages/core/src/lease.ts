import { leasePolicySchema, type LeasePolicy, type LeaseRecord } from '@skiff/contracts';

/**
 * Control-plane lease (docs/CLUSTERING.md §6.3, C6).
 *
 * The lease is one object with a conditional write. This class owns the decision logic; the
 * object store owns the CAS. It is deliberately independent of ingress, SQLite and agent state
 * so the split-brain rules are testable.
 */
export interface LeaseVersioned {
	record: LeaseRecord;
	version: number;
}

export interface LeaseStore {
	read(): Promise<LeaseVersioned | null>;
	/** `expectedVersion` null means create; false means the store rejected the write. */
	compareAndSwap(expectedVersion: number | null, record: LeaseRecord): Promise<boolean>;
}

export type LeaseState = 'holder' | 'standby' | 'fenced';

export interface LeaseDecision {
	state: LeaseState;
	record: LeaseRecord;
	/** True when this call changed the stored object. */
	changed: boolean;
}

export class ControlPlaneLease {
	private readonly policy: LeasePolicy;
	constructor(
		private readonly store: LeaseStore,
		private readonly nodeId: string,
		policy: Partial<LeasePolicy> = {},
	) {
		this.policy = leasePolicySchema.parse(policy);
	}

	async acquire(now: number): Promise<LeaseDecision> {
		const current = await this.store.read();
		if (!current) {
			const record: LeaseRecord = { epoch: 1, holderNodeId: this.nodeId, expiresAt: now + this.policy.ttlMs };
			const won = await this.store.compareAndSwap(null, record);
			return won
				? { state: 'holder', record, changed: true }
				: { state: 'standby', record, changed: false };
		}
		if (current.record.holderNodeId === this.nodeId) {
			if (current.record.expiresAt - now > this.policy.renewBeforeMs)
				return { state: 'holder', record: current.record, changed: false };
			return this.renew(current, now);
		}
		if (current.record.expiresAt > now) return { state: 'standby', record: current.record, changed: false };
		const next: LeaseRecord = {
			epoch: current.record.epoch + 1,
			holderNodeId: this.nodeId,
			expiresAt: now + this.policy.ttlMs,
		};
		const won = await this.store.compareAndSwap(current.version, next);
		return won
			? { state: 'holder', record: next, changed: true }
			: { state: 'standby', record: current.record, changed: false };
	}

	async renew(current: LeaseVersioned, now: number): Promise<LeaseDecision> {
		const next: LeaseRecord = { ...current.record, expiresAt: now + this.policy.ttlMs };
		const won = await this.store.compareAndSwap(current.version, next);
		return won
			? { state: 'holder', record: next, changed: true }
			: { state: 'fenced', record: current.record, changed: false };
	}

	/** Give up the lease by bumping the epoch and expiring it immediately. */
	async release(): Promise<void> {
		const current = await this.store.read();
		if (!current || current.record.holderNodeId !== this.nodeId) return;
		await this.store.compareAndSwap(current.version, {
			epoch: current.record.epoch + 1,
			holderNodeId: this.nodeId,
			expiresAt: 0,
		});
	}
}

/** In-memory CAS store for tests and single-process simulations. */
export class MemoryLeaseStore implements LeaseStore {
	private current: LeaseVersioned | null = null;
	async read(): Promise<LeaseVersioned | null> {
		return this.current ? { ...this.current, record: { ...this.current.record } } : null;
	}
	async compareAndSwap(expectedVersion: number | null, record: LeaseRecord): Promise<boolean> {
		const version = this.current?.version ?? 0;
		if (expectedVersion !== (this.current ? version : null)) return false;
		this.current = { record: { ...record }, version: version + 1 };
		return true;
	}
}
