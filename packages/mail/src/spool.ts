import { Database } from 'bun:sqlite';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emailEventSchema, type EmailEvent, type EmailEventInput } from '@skiff/contracts';

/**
 * The durable spool (EMAIL.md §3.2). One SQLite database in WAL mode holds message and
 * per-recipient state plus the outgoing event log; message bodies are `.eml` files beside it,
 * written and fsynced before the row commits. A message is only ever acknowledged ("250 OK", or
 * an injection ack to the agent) after both are on disk.
 *
 * Events and state change in the same transaction, so an event the agent reads always describes a
 * state the spool really reached.
 */

export type RecipientStatus = 'queued' | 'deferred' | 'delivered' | 'bounced';

export interface SpoolMessage {
	id: string;
	orgId: string;
	projectId: string | null;
	/** Header From address (the identity that was authorised and signed). */
	from: string;
	source: 'api' | 'smtp' | 'inbound';
	tags: Record<string, string>;
	sizeBytes: number;
	createdAt: number;
}

export interface SpoolRecipient {
	messageId: string;
	index: number;
	address: string;
	domain: string;
	status: RecipientStatus;
	attempts: number;
	nextAttemptAt: number;
	lastResponse: string | null;
}

export type EventInput = Omit<EmailEventInput, 'seq'>;

export interface HistoryEntry {
	messageId: string;
	index: number;
	address: string;
	orgId: string;
	projectId: string | null;
	tags: Record<string, string>;
}

interface HistoryRow {
	message_id: string;
	idx: number;
	address: string;
	org_id: string;
	project_id: string | null;
	tags_json: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL,
	project_id TEXT,
	sender TEXT NOT NULL,
	source TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '{}',
	size_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recipients (
	message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	idx INTEGER NOT NULL,
	address TEXT NOT NULL,
	domain TEXT NOT NULL,
	status TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL,
	last_response TEXT,
	PRIMARY KEY (message_id, idx)
);
CREATE INDEX IF NOT EXISTS recipients_due ON recipients (status, next_attempt_at);
-- Who each message went to, kept 30 days after acceptance so asynchronous bounces and complaint
-- reports (which arrive after the message has left the spool) can be attributed.
CREATE TABLE IF NOT EXISTS history (
	message_id TEXT NOT NULL,
	idx INTEGER NOT NULL,
	address TEXT NOT NULL,
	org_id TEXT NOT NULL,
	project_id TEXT,
	tags_json TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	PRIMARY KEY (message_id, idx)
);
CREATE INDEX IF NOT EXISTS history_created ON history (created_at);
CREATE TABLE IF NOT EXISTS events (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	body TEXT NOT NULL
);
`;

interface MessageRow {
	id: string;
	org_id: string;
	project_id: string | null;
	sender: string;
	source: string;
	tags_json: string;
	size_bytes: number;
	created_at: number;
}

interface RecipientRow {
	message_id: string;
	idx: number;
	address: string;
	domain: string;
	status: string;
	attempts: number;
	next_attempt_at: number;
	last_response: string | null;
}

const toMessage = (row: MessageRow): SpoolMessage => ({
	id: row.id,
	orgId: row.org_id,
	projectId: row.project_id,
	from: row.sender,
	source: row.source as SpoolMessage['source'],
	tags: JSON.parse(row.tags_json) as Record<string, string>,
	sizeBytes: row.size_bytes,
	createdAt: row.created_at,
});

const toRecipient = (row: RecipientRow): SpoolRecipient => ({
	messageId: row.message_id,
	index: row.idx,
	address: row.address,
	domain: row.domain,
	status: row.status as RecipientStatus,
	attempts: row.attempts,
	nextAttemptAt: row.next_attempt_at,
	lastResponse: row.last_response,
});

function writeDurable(path: string, data: Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp`;
	const fd = openSync(temp, 'w', 0o600);
	try {
		let offset = 0;
		while (offset < data.length) offset += writeSync(fd, data, offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	const dirFd = openSync(dirname(path), 'r');
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

export class Spool {
	readonly db: Database;
	private readonly bodies: string;

	constructor(dir: string) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.bodies = join(dir, 'msgs');
		this.db = new Database(join(dir, 'spool.db'), { create: true, strict: true });
		this.db.exec('PRAGMA foreign_keys = ON;');
		this.db.exec(SCHEMA);
	}

	close(): void {
		this.db.close();
	}

	bodyPath(id: string): string {
		return join(this.bodies, id.slice(3, 5) || '00', `${id}.eml`);
	}

	has(id: string): boolean {
		return this.db.query('SELECT 1 FROM messages WHERE id = ?').get(id) !== null;
	}

	/**
	 * Spool a signed message. Writes the body durably, then commits the rows and the `accepted`
	 * (plus any `suppressed`) events in one transaction. Idempotent on the message id.
	 */
	accept(
		message: Omit<SpoolMessage, 'createdAt' | 'sizeBytes'> & { subject?: string | null },
		body: Uint8Array,
		recipients: string[],
		extraEvents: EventInput[] = [],
		now = Date.now(),
	): boolean {
		if (this.has(message.id)) return false;
		writeDurable(this.bodyPath(message.id), body);
		const insertMessage = this.db.query(
			'INSERT INTO messages (id, org_id, project_id, sender, source, tags_json, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		);
		const insertRecipient = this.db.query(
			'INSERT INTO recipients (message_id, idx, address, domain, status, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
		);
		const insertHistory = this.db.query(
			'INSERT OR IGNORE INTO history (message_id, idx, address, org_id, project_id, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
		);
		this.db.transaction(() => {
			insertMessage.run(
				message.id,
				message.orgId,
				message.projectId,
				message.from,
				message.source,
				JSON.stringify(message.tags),
				body.byteLength,
				now,
			);
			recipients.forEach((address, index) => {
				const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
				insertRecipient.run(message.id, index, address, domain, 'queued', now);
				insertHistory.run(message.id, index, address, message.orgId, message.projectId, JSON.stringify(message.tags), now);
				this.emitInTx({
					kind: 'accepted',
					messageId: message.id,
					orgId: message.orgId,
					projectId: message.projectId,
					recipient: address,
					recipientIndex: index,
					at: new Date(now).toISOString(),
					attempt: 0,
					severity: null,
					bounceClass: null,
					remoteHost: null,
					response: null,
					tls: null,
					source: message.source,
					feedbackType: null,
					tags: message.tags,
					from: message.from,
					subject: message.subject ?? null,
				});
			});
			for (const event of extraEvents) this.emitInTx(event);
		})();
		return true;
	}

	message(id: string): SpoolMessage | null {
		const row = this.db.query('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | null;
		return row ? toMessage(row) : null;
	}

	body(id: string): Buffer {
		return readFileSync(this.bodyPath(id));
	}

	recipient(messageId: string, index: number): SpoolRecipient | null {
		const row = this.db
			.query('SELECT * FROM recipients WHERE message_id = ? AND idx = ?')
			.get(messageId, index) as RecipientRow | null;
		return row ? toRecipient(row) : null;
	}

	/** Recipients whose next attempt is due, oldest first. */
	due(now: number, limit = 500): SpoolRecipient[] {
		return (
			this.db
				.query(
					"SELECT * FROM recipients WHERE status IN ('queued', 'deferred') AND next_attempt_at <= ? ORDER BY next_attempt_at, message_id, idx LIMIT ?",
				)
				.all(now, limit) as RecipientRow[]
		).map(toRecipient);
	}

	/** Earliest pending attempt, so the scheduler can sleep until then. */
	nextDueAt(): number | null {
		const row = this.db
			.query("SELECT MIN(next_attempt_at) AS at FROM recipients WHERE status IN ('queued', 'deferred')")
			.get() as { at: number | null };
		return row.at;
	}

	/**
	 * Record an attempt's outcome and its event in one transaction. When every recipient of the
	 * message is final, the message row and its body go too.
	 */
	settle(
		recipient: SpoolRecipient,
		update: { status: RecipientStatus; nextAttemptAt?: number; response: string | null },
		event: EventInput | null,
	): void {
		this.db.transaction(() => {
			this.db
				.query(
					'UPDATE recipients SET status = ?, attempts = attempts + 1, next_attempt_at = ?, last_response = ? WHERE message_id = ? AND idx = ?',
				)
				.run(
					update.status,
					update.nextAttemptAt ?? recipient.nextAttemptAt,
					update.response,
					recipient.messageId,
					recipient.index,
				);
			if (event) this.emitInTx(event);
		})();
		this.collect(recipient.messageId);
	}

	/** Delete a message once no recipient is pending. */
	collect(messageId: string): boolean {
		const pending = this.db
			.query("SELECT COUNT(*) AS n FROM recipients WHERE message_id = ? AND status IN ('queued', 'deferred')")
			.get(messageId) as { n: number };
		if (pending.n > 0) return false;
		this.db.query('DELETE FROM messages WHERE id = ?').run(messageId);
		rmSync(this.bodyPath(messageId), { force: true });
		return true;
	}

	/** The recipient a VERP address or trace header points at, if it was sent in the last 30 days. */
	sent(messageId: string, index: number | null): HistoryEntry | null {
		const row = (
			index === null
				? this.db.query('SELECT * FROM history WHERE message_id = ? ORDER BY idx LIMIT 1').get(messageId)
				: this.db.query('SELECT * FROM history WHERE message_id = ? AND idx = ?').get(messageId, index)
		) as HistoryRow | null;
		if (!row) return null;
		return {
			messageId: row.message_id,
			index: row.idx,
			address: row.address,
			orgId: row.org_id,
			projectId: row.project_id,
			tags: JSON.parse(row.tags_json) as Record<string, string>,
		};
	}

	pruneHistory(olderThan: number): number {
		return this.db.query('DELETE FROM history WHERE created_at < ?').run(olderThan).changes;
	}

	counts(): { queued: number; deferred: number; oldestQueuedAt: number | null } {
		const row = this.db
			.query(
				"SELECT SUM(status = 'queued') AS queued, SUM(status = 'deferred') AS deferred, MIN(m.created_at) AS oldest FROM recipients r JOIN messages m ON m.id = r.message_id WHERE r.status IN ('queued', 'deferred')",
			)
			.get() as { queued: number | null; deferred: number | null; oldest: number | null };
		return { queued: row.queued ?? 0, deferred: row.deferred ?? 0, oldestQueuedAt: row.oldest };
	}

	// --- events ------------------------------------------------------------------------------

	private emitInTx(event: EventInput): void {
		this.db.query('INSERT INTO events (body) VALUES (?)').run(JSON.stringify(event));
	}

	emit(event: EventInput): void {
		this.emitInTx(event);
	}

	events(after: number, limit = 500): EmailEvent[] {
		const rows = this.db
			.query('SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
			.all(after, limit) as Array<{ seq: number; body: string }>;
		return rows.map((row) => emailEventSchema.parse({ ...(JSON.parse(row.body) as object), seq: row.seq }));
	}

	ack(upTo: number): number {
		return this.db.query('DELETE FROM events WHERE seq <= ?').run(upTo).changes;
	}

	pendingEvents(): number {
		return (this.db.query('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
	}
}
