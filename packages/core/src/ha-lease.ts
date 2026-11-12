import type { ConditionalStore, ConditionalWrite, VersionedRead, WriteCondition } from './object-store.ts';

/**
 * The cross-host control-plane lease (docs/CLUSTERING.md §6.3, H10; phase C6, client owned by C5).
 *
 * One object in the platform object store names the primary. Every write is a conditional PUT, so
 * the store, not either control node, decides who holds it:
 *
 * - **Clock.** Only the store's `Date` header is trusted. `expiresAt` is `serverDate + ttl`; time
 *   between two responses is measured on the local monotonic clock, never the wall clock.
 * - **Primary.** Renews with `If-Match` every tick. With no confirmed renewal for `fenceAfterMs`
 *   (20 s) it fences: it must stop writes, agent routes and maintenance. A fenced node never
 *   resumes by itself; it is re-seeded (§6.6).
 * - **Standby.** Never writes, except a takeover: the object it read must be unchanged for
 *   `takeoverAfterMs` (40 s = TTL + twice the skew tolerance) *and* past `expiresAt` by the store's
 *   clock, so a slow holder never loses to a fast standby. A `released` lease (planned switchover)
 *   can be taken at once, because its holder already stopped writing.
 * - **Losing a race** (409/412) is final for that term: re-read, never retry blindly. A 501 or a
 *   missing ETag means the store has no conditional write, so HA fails closed.
 *
 * This class is deliberately free of SQLite, HTTP routes and agent state; `holds()` is the check a
 * write path makes, and the caller wires role changes to the process (§6.1).
 */
export const CONTROL_LEASE_KEY = 'yoal/ha/control-lease.json';

export interface ControlLeaseRecord {
	epoch: number;
	holderNodeId: string;
	holderVersion?: string;
	/** Store-clock epoch ms. */
	expiresAt: number;
	/** Set by a clean hand-over; the next holder need not wait out the TTL. */
	released?: boolean;
}

export type ControlLeaseRole = 'unknown' | 'primary' | 'standby' | 'fenced' | 'unavailable';

export interface ControlLeasePolicy {
	ttlMs: number;
	/** The primary fences after this long without a confirmed renewal. Must be < ttlMs. */
	fenceAfterMs: number;
	/** A standby takes over only after observing one unchanged object this long. Must be > ttlMs. */
	takeoverAfterMs: number;
	/** Tolerated |node − store| clock difference before `skewExceeded`. */
	skewToleranceMs: number;
}

export const DEFAULT_CONTROL_LEASE_POLICY: ControlLeasePolicy = {
	ttlMs: 30_000,
	fenceAfterMs: 20_000,
	takeoverAfterMs: 40_000,
	skewToleranceMs: 5_000,
};

export interface ControlLeaseStatus {
	role: ControlLeaseRole;
	/** The epoch this node holds (primary) or last saw (others). 0 before the first read. */
	epoch: number;
	holderNodeId: string | null;
	/** Store-clock ms. */
	expiresAt: number | null;
	released: boolean;
	/** Node wall clock minus store clock, from the last response with a `Date`. */
	skewMs: number | null;
	skewExceeded: boolean;
	/** Monotonic ms of the last confirmed write by this node as primary. */
	lastConfirmedAt: number | null;
	/** Why the role is what it is, for status pages and logs. */
	reason: string;
}

export interface ControlLeaseOptions {
	store: ConditionalStore;
	nodeId: string;
	version?: string;
	key?: string;
	policy?: Partial<ControlLeasePolicy>;
	/** Monotonic milliseconds. Defaults to `performance.now()`. */
	monotonic?: () => number;
	/** Wall clock, used only to report skew. */
	wallClock?: () => number;
}

export class ControlLeaseError extends Error {}

export class ControlLease {
	readonly policy: ControlLeasePolicy;
	readonly key: string;
	readonly #store: ConditionalStore;
	readonly #nodeId: string;
	readonly #version: string | undefined;
	readonly #monotonic: () => number;
	readonly #wallClock: () => number;

	#role: ControlLeaseRole = 'unknown';
	#epoch = 0;
	#record: ControlLeaseRecord | null = null;
	#etag: string | null = null;
	#lastConfirmedAt: number | null = null;
	#observedEtag: string | null = null;
	#observedSince = 0;
	#skewMs: number | null = null;
	#reason = 'not read yet';

	constructor(options: ControlLeaseOptions) {
		this.policy = { ...DEFAULT_CONTROL_LEASE_POLICY, ...options.policy };
		if (this.policy.fenceAfterMs >= this.policy.ttlMs)
			throw new ControlLeaseError('fenceAfterMs must be shorter than the TTL, or a deposed primary can overlap its successor.');
		if (this.policy.takeoverAfterMs <= this.policy.ttlMs)
			throw new ControlLeaseError('takeoverAfterMs must be longer than the TTL.');
		this.#store = options.store;
		this.#nodeId = options.nodeId;
		this.#version = options.version;
		this.key = options.key ?? CONTROL_LEASE_KEY;
		this.#monotonic = options.monotonic ?? (() => performance.now());
		this.#wallClock = options.wallClock ?? Date.now;
	}

	status(): ControlLeaseStatus {
		return {
			role: this.#role,
			epoch: this.#epoch,
			holderNodeId: this.#record?.holderNodeId ?? null,
			expiresAt: this.#record?.expiresAt ?? null,
			released: this.#record?.released === true,
			skewMs: this.#skewMs,
			skewExceeded: this.#skewMs !== null && Math.abs(this.#skewMs) > this.policy.skewToleranceMs,
			lastConfirmedAt: this.#lastConfirmedAt,
			reason: this.#reason,
		};
	}

	/**
	 * The fencing check for a write: primary, and a renewal confirmed within `fenceAfterMs`. A
	 * primary whose ticks stalled (a blocked event loop) stops passing this before it can be deposed.
	 */
	holds(): boolean {
		return (
			this.#role === 'primary' &&
			this.#lastConfirmedAt !== null &&
			this.#monotonic() - this.#lastConfirmedAt < this.policy.fenceAfterMs
		);
	}

	/**
	 * Enable HA on the current single control plane: create the lease at `epoch` (agents must never
	 * see the epoch go down, so pass one above anything they have seen). Fails if the object exists
	 * and names someone else.
	 */
	async bootstrap(epoch = 1): Promise<ControlLeaseStatus> {
		if (!Number.isInteger(epoch) || epoch < 1) throw new ControlLeaseError('The first epoch is a positive integer.');
		const read = await this.#read();
		if (read.kind === 'error') throw new ControlLeaseError(`The lease store is unavailable: ${read.reason}`);
		if (read.kind === 'present') {
			if (read.record.holderNodeId !== this.#nodeId)
				throw new ControlLeaseError(`The lease already exists and names ${read.record.holderNodeId} at epoch ${read.record.epoch}.`);
			return this.tick();
		}
		const write = await this.#write(
			{ epoch, holderNodeId: this.#nodeId, expiresAt: this.#expiry(read.serverDate) },
			{ ifNoneMatch: '*' },
		);
		if (write.outcome === 'won') return this.status();
		throw new ControlLeaseError(`Could not create the lease: ${this.#reason}`);
	}

	/**
	 * One step of the protocol; call every renew interval (5 s). `mayTakeOver` is the caller's
	 * promotion gate: replay current, `ha.mode=auto` or an operator's Promote (§6.5).
	 */
	async tick(options: { mayTakeOver?: boolean } = {}): Promise<ControlLeaseStatus> {
		if (this.#role === 'fenced') return this.status();
		const read = await this.#read();
		if (read.kind === 'error') {
			this.#onUnreachable(read.reason);
			return this.status();
		}
		if (read.kind === 'absent') {
			if (this.#role === 'primary') return this.#fence('the lease object disappeared while this node held it');
			this.#role = 'unavailable';
			this.#reason = 'no lease exists; HA is not bootstrapped';
			return this.status();
		}
		const { record, etag, serverDate } = read;
		this.#record = record;
		this.#etag = etag;

		if (record.holderNodeId === this.#nodeId) {
			// Ours. A restarted process (role unknown) may continue an unexpired term it held; a
			// node that was standby or primary at another epoch must not adopt it silently.
			const continuing =
				(this.#role === 'primary' && record.epoch === this.#epoch) ||
				(this.#role === 'unknown' && !record.released && record.expiresAt > (serverDate ?? Number.POSITIVE_INFINITY));
			if (!continuing) {
				if (this.#role === 'primary') return this.#fence(`the lease moved to epoch ${record.epoch} under this node`);
				return this.#follow(record, etag, 'the lease names this node from an earlier term');
			}
			this.#epoch = record.epoch;
			const write = await this.#write(
				{ ...record, holderVersion: this.#version ?? record.holderVersion, expiresAt: this.#expiry(serverDate), released: undefined },
				{ ifMatch: etag },
			);
			if (write.outcome === 'lost') return this.#fence('a renewal lost the compare-and-swap');
			return this.status();
		}

		// Someone else's.
		if (this.#role === 'primary') return this.#fence(`${record.holderNodeId} holds the lease at epoch ${record.epoch}`);
		this.#follow(record, etag, `following ${record.holderNodeId} at epoch ${record.epoch}`);
		if (!options.mayTakeOver) return this.status();

		const observedFor = this.#monotonic() - this.#observedSince;
		const expired = serverDate !== null && serverDate >= record.expiresAt;
		const takeover = record.released || (expired && observedFor >= this.policy.takeoverAfterMs);
		if (!takeover) {
			this.#reason = record.released
				? this.#reason
				: `following ${record.holderNodeId}; takeover needs the lease expired and unchanged for ${Math.round(this.policy.takeoverAfterMs / 1000)} s`;
			return this.status();
		}
		return this.#takeOver(record, etag, serverDate);
	}

	/**
	 * Planned switchover: mark the lease released so a standby takes it without waiting out the
	 * TTL. The caller must already have stopped writes; this node is a standby afterwards.
	 */
	async release(): Promise<ControlLeaseStatus> {
		if (this.#role !== 'primary' || !this.#record || !this.#etag) return this.status();
		const read = await this.#read();
		if (read.kind !== 'present' || read.record.holderNodeId !== this.#nodeId || read.record.epoch !== this.#epoch)
			return this.#fence('the lease changed before it could be released');
		const write = await this.#write(
			{ ...read.record, expiresAt: read.serverDate ?? read.record.expiresAt, released: true },
			{ ifMatch: read.etag },
			'standby',
		);
		if (write.outcome !== 'won') return this.#fence('the release lost the compare-and-swap');
		this.#reason = 'released for a switchover';
		return this.status();
	}

	/**
	 * Break-glass promotion (§18.5): take the lease now, without waiting for expiry. Only after an
	 * operator has confirmed the old primary's units are stopped. Still a compare-and-swap against
	 * the object just read, so two operators cannot both win.
	 */
	async forcePromote(): Promise<ControlLeaseStatus> {
		if (this.#role === 'fenced') throw new ControlLeaseError('A fenced node is re-seeded before it can be promoted.');
		const read = await this.#read();
		if (read.kind === 'error') throw new ControlLeaseError(`The lease store is unavailable: ${read.reason}`);
		if (read.kind === 'absent') throw new ControlLeaseError('No lease exists; bootstrap HA instead.');
		if (read.record.holderNodeId === this.#nodeId && this.#role === 'primary') return this.status();
		return this.#takeOver(read.record, read.etag, read.serverDate);
	}

	/** Operator acknowledgement after a fenced node was re-seeded from the new primary (§6.6). */
	resetAfterReseed(): void {
		this.#role = 'unknown';
		this.#lastConfirmedAt = null;
		this.#observedEtag = null;
		this.#reason = 're-seeded; not read yet';
	}

	async #takeOver(record: ControlLeaseRecord, etag: string, serverDate: number | null): Promise<ControlLeaseStatus> {
		const next: ControlLeaseRecord = {
			epoch: record.epoch + 1,
			holderNodeId: this.#nodeId,
			...(this.#version ? { holderVersion: this.#version } : {}),
			expiresAt: this.#expiry(serverDate),
		};
		const write = await this.#write(next, { ifMatch: etag });
		if (write.outcome === 'won') this.#reason = `took over at epoch ${next.epoch} from ${record.holderNodeId}`;
		else if (write.outcome === 'lost') this.#reason = 'lost the takeover race; following the winner';
		return this.status();
	}

	#follow(record: ControlLeaseRecord, etag: string, reason: string): ControlLeaseStatus {
		if (etag !== this.#observedEtag) {
			this.#observedEtag = etag;
			this.#observedSince = this.#monotonic();
		}
		this.#role = 'standby';
		this.#epoch = record.epoch;
		this.#reason = reason;
		return this.status();
	}

	#fence(reason: string): ControlLeaseStatus {
		this.#role = 'fenced';
		this.#reason = reason;
		return this.status();
	}

	#onUnreachable(reason: string): void {
		if (this.#role === 'primary') {
			const since = this.#lastConfirmedAt === null ? Number.POSITIVE_INFINITY : this.#monotonic() - this.#lastConfirmedAt;
			if (since >= this.policy.fenceAfterMs) {
				this.#fence(`no confirmed renewal for ${Math.round(since / 1000)} s (${reason})`);
				return;
			}
			this.#reason = `renewal failed (${reason}); fencing in ${Math.ceil((this.policy.fenceAfterMs - since) / 1000)} s`;
			return;
		}
		// A standby that cannot read cannot judge expiry, so it forgets what it observed.
		this.#observedEtag = null;
		if (this.#role === 'unknown') this.#role = 'unavailable';
		this.#reason = `lease store unreachable (${reason})`;
	}

	#expiry(serverDate: number | null): number {
		if (serverDate === null)
			throw new ControlLeaseError('The lease store sent no Date header, so expiry cannot use its clock.');
		return serverDate + this.policy.ttlMs;
	}

	#noteSkew(serverDate: number | null): void {
		if (serverDate !== null) this.#skewMs = this.#wallClock() - serverDate;
	}

	async #read(): Promise<
		| { kind: 'present'; record: ControlLeaseRecord; etag: string; serverDate: number | null }
		| { kind: 'absent'; serverDate: number | null }
		| { kind: 'error'; reason: string }
	> {
		let response: VersionedRead;
		try {
			response = await this.#store.readVersioned(this.key);
		} catch (error) {
			return { kind: 'error', reason: error instanceof Error ? error.message : String(error) };
		}
		this.#noteSkew(response.serverDate);
		if (response.serverDate === null && (response.status === 200 || response.status === 404))
			return { kind: 'error', reason: 'the store sent no Date header, and expiry is judged only on its clock' };
		if (response.status === 404) return { kind: 'absent', serverDate: response.serverDate };
		if (response.status !== 200) return { kind: 'error', reason: `GET ${response.status}` };
		if (!response.etag) return { kind: 'error', reason: 'the store returned no ETag, so it cannot arbitrate a lease' };
		const record = parseRecord(response.body);
		if (!record) return { kind: 'error', reason: 'the lease object is not a valid lease' };
		return { kind: 'present', record, etag: response.etag, serverDate: response.serverDate };
	}

	async #write(
		record: ControlLeaseRecord,
		condition: WriteCondition,
		roleOnWin: ControlLeaseRole = 'primary',
	): Promise<{ outcome: 'won' | 'lost' | 'error' }> {
		let response: ConditionalWrite;
		try {
			response = await this.#store.writeConditional(this.key, JSON.stringify(stripUndefined(record)), condition);
		} catch (error) {
			this.#onUnreachable(error instanceof Error ? error.message : String(error));
			return { outcome: 'error' };
		}
		this.#noteSkew(response.serverDate);
		if (response.status === 200 && response.etag) {
			this.#record = record;
			this.#etag = response.etag;
			this.#epoch = record.epoch;
			this.#role = roleOnWin;
			if (roleOnWin === 'primary') {
				this.#lastConfirmedAt = this.#monotonic();
				this.#reason = `primary at epoch ${record.epoch}`;
			}
			return { outcome: 'won' };
		}
		if (response.status === 409 || response.status === 412) {
			this.#reason = `compare-and-swap lost (${response.status})`;
			return { outcome: 'lost' };
		}
		if (response.status === 501 || (response.status === 200 && !response.etag)) {
			this.#role = this.#role === 'primary' ? 'fenced' : 'unavailable';
			this.#reason = 'the store has no conditional write; HA fails closed';
			return { outcome: 'error' };
		}
		this.#onUnreachable(`PUT ${response.status}`);
		return { outcome: 'error' };
	}
}

function parseRecord(body: string | null): ControlLeaseRecord | null {
	if (!body) return null;
	try {
		const value = JSON.parse(body) as Partial<ControlLeaseRecord>;
		if (
			typeof value.epoch !== 'number' ||
			!Number.isInteger(value.epoch) ||
			value.epoch < 1 ||
			typeof value.holderNodeId !== 'string' ||
			!value.holderNodeId ||
			typeof value.expiresAt !== 'number'
		)
			return null;
		return {
			epoch: value.epoch,
			holderNodeId: value.holderNodeId,
			expiresAt: value.expiresAt,
			...(typeof value.holderVersion === 'string' ? { holderVersion: value.holderVersion } : {}),
			...(value.released === true ? { released: true } : {}),
		};
	} catch {
		return null;
	}
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * An in-memory conditional store with the semantics S3/R2 promise and the faults the §19.3 lab
 * injects: a fixed status for the next requests, a missing ETag, and a store clock you control.
 */
export class MemoryConditionalStore implements ConditionalStore {
	#objects = new Map<string, { body: string; etag: string }>();
	#counter = 0;
	/** Next N operations answer with this status instead (e.g. 500, 501, 503). */
	failNext: { status: number; count: number } | null = null;
	/** Throw (network error) on the next N operations. */
	throwNext = 0;
	/** Omit the ETag on writes and reads (a store without conditional support). */
	dropEtag = false;

	constructor(public serverClock: () => number = Date.now) {}

	async readVersioned(key: string): Promise<VersionedRead> {
		const fault = this.#fault();
		if (fault) return { status: fault, body: null, etag: null, serverDate: this.serverClock() };
		const object = this.#objects.get(key);
		if (!object) return { status: 404, body: null, etag: null, serverDate: this.serverClock() };
		return { status: 200, body: object.body, etag: this.dropEtag ? null : object.etag, serverDate: this.serverClock() };
	}

	async writeConditional(key: string, body: string, condition: WriteCondition): Promise<ConditionalWrite> {
		const fault = this.#fault();
		if (fault) return { status: fault, etag: null, serverDate: this.serverClock() };
		const current = this.#objects.get(key);
		if ('ifNoneMatch' in condition ? current !== undefined : current?.etag !== condition.ifMatch)
			return { status: 412, etag: null, serverDate: this.serverClock() };
		const etag = `"${++this.#counter}"`;
		this.#objects.set(key, { body, etag });
		return { status: 200, etag: this.dropEtag ? null : etag, serverDate: this.serverClock() };
	}

	/**
	 * One node's path to this store, with its own faults: `partitioned` makes every call from it
	 * fail like a dropped connection while other views keep working (§19.3 partition fault).
	 */
	view(): ConditionalStore & { partitioned: boolean } {
		const store = this;
		return {
			partitioned: false,
			async readVersioned(key) {
				if (this.partitioned) throw new Error('partitioned');
				return store.readVersioned(key);
			},
			async writeConditional(key, body, condition) {
				if (this.partitioned) throw new Error('partitioned');
				return store.writeConditional(key, body, condition);
			},
		};
	}

	/** Direct access for tests: what is stored now. */
	peek(key: string = CONTROL_LEASE_KEY): ControlLeaseRecord | null {
		return parseRecord(this.#objects.get(key)?.body ?? null);
	}

	#fault(): number | null {
		if (this.throwNext > 0) {
			this.throwNext--;
			throw new Error('connection reset');
		}
		if (this.failNext && this.failNext.count > 0) {
			this.failNext.count--;
			return this.failNext.status;
		}
		return null;
	}
}
