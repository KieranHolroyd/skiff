import type { createDb } from '@skiff/db';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * First-run setup (DESIGN §12, D102). A fresh install has no users; the person who deployed it
 * proves they control the host with the one-time **setup token** and the wizard at `/setup`
 * creates the owner in one atomic step. Nothing else can create the first user: sign-up through
 * Better Auth (magic link, GitHub, passkey) is refused until setup is complete.
 *
 * The owner signs in with email + password (D103) and must also enrol a passkey or authenticator
 * app (D10), so an install reachable only over plain HTTP or an IP address can still be set up.
 *
 * Everything here takes its database and paths as arguments so it is unit-tested without the
 * SvelteKit runtime; `routes/setup` and `hooks.server.ts` wire it to the real config.
 */

type Database = ReturnType<typeof createDb>['sqlite'];

/** Where the installer writes the token (`root:skiff 0640`, docs/OPS.md §1). */
export const DEFAULT_SETUP_TOKEN_FILE = '/etc/skiff/setup-token';
/** Cookie that carries a verified token between wizard steps (never readable by scripts). */
export const SETUP_COOKIE = 'skiff-setup';
const MIN_TOKEN_LENGTH = 24;

/** Password rules for every Skiff account (Better Auth is configured with the same bounds, D103). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Why a password is unacceptable, or undefined when it is fine. */
export function passwordProblem(password: string, confirm?: string): string | undefined {
	if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
	if (confirm !== undefined && confirm !== password) return 'The passwords do not match.';
	return undefined;
}

/** True while no user exists. A database without Better Auth's tables yet also needs setup. */
export function needsSetup(sqlite: Database): boolean {
	try {
		return !sqlite.query('SELECT 1 FROM user LIMIT 1').get();
	} catch {
		return true;
	}
}

export interface SetupToken {
	token: string;
	/** The file it was read from (or written to), for operator-facing hints. */
	file: string;
}

/**
 * The setup token. The installer's file wins; when it is missing or unreadable (dev servers,
 * hand-rolled installs, an older installer that wrote it `root 0600`) the control plane generates
 * its own in the data directory, so setup never depends on the installer having got it right.
 */
export function resolveSetupToken(options: {
	configuredFile: string | undefined;
	dataDir: string;
	warn?: (message: string) => void;
}): SetupToken {
	const configured = options.configuredFile?.trim();
	if (configured) {
		const token = readToken(configured);
		if (token) return { token, file: configured };
		if (existsSync(configured))
			options.warn?.(
				`[setup] ${configured} exists but is not readable by this process (want root:skiff 0640); using a token in ${options.dataDir} instead`,
			);
	}
	const fallback = join(options.dataDir, 'setup-token');
	const existing = readToken(fallback);
	if (existing) return { token: existing, file: fallback };
	mkdirSync(options.dataDir, { recursive: true });
	const token = randomBytes(32).toString('base64url');
	writeFileSync(fallback, `${token}\n`, { mode: 0o600 });
	try {
		chmodSync(fallback, 0o600);
	} catch {
		// Best effort: the mode passed to writeFileSync already applies to a new file.
	}
	return { token, file: fallback };
}

function readToken(file: string): string | undefined {
	try {
		const value = readFileSync(file, 'utf8').trim();
		return value.length >= MIN_TOKEN_LENGTH ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Constant-time comparison; hashing first makes the lengths equal. */
export function setupTokenMatches(expected: string, candidate: string | null | undefined): boolean {
	if (!candidate) return false;
	const a = createHash('sha256').update(expected).digest();
	const b = createHash('sha256').update(candidate.trim()).digest();
	return timingSafeEqual(a, b);
}

export function setupUrl(platformOrigin: string, token: string): string {
	return `${platformOrigin}/setup?token=${encodeURIComponent(token)}`;
}

export interface ClaimInput {
	name: string;
	email: string;
	organizationName: string;
	password: string;
}

export type ParsedClaim = { ok: true; value: ClaimInput } | { ok: false; field: keyof ClaimInput; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseClaimInput(raw: {
	name?: unknown;
	email?: unknown;
	organizationName?: unknown;
	password?: unknown;
	/** Checked only when given (the wizard sends it; the server-side endpoint does not). */
	passwordConfirm?: unknown;
}): ParsedClaim {
	const name = typeof raw.name === 'string' ? raw.name.trim() : '';
	const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
	const organizationName = typeof raw.organizationName === 'string' ? raw.organizationName.trim() : '';
	// Passwords are never trimmed: spaces are characters.
	const password = typeof raw.password === 'string' ? raw.password : '';
	const confirm = typeof raw.passwordConfirm === 'string' ? raw.passwordConfirm : undefined;
	if (!name) return { ok: false, field: 'name', message: 'Enter your name.' };
	if (name.length > 100) return { ok: false, field: 'name', message: 'Use at most 100 characters.' };
	if (!EMAIL.test(email) || email.length > 254)
		return { ok: false, field: 'email', message: 'Enter a valid email address.' };
	if (!organizationName) return { ok: false, field: 'organizationName', message: 'Name your organisation.' };
	if (organizationName.length > 80)
		return { ok: false, field: 'organizationName', message: 'Use at most 80 characters.' };
	const problem = passwordProblem(password, confirm);
	if (problem) return { ok: false, field: 'password', message: problem };
	return { ok: true, value: { name, email, organizationName, password } };
}

export class SetupAlreadyCompleteError extends Error {
	constructor() {
		super('Setup is already complete. Sign in instead.');
		this.name = 'SetupAlreadyCompleteError';
	}
}

/** URL-safe org slug; a random suffix keeps it unique without a lookup. */
export function organizationSlug(name: string): string {
	const base = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	const suffix = randomBytes(3).toString('hex');
	return base ? `${base}-${suffix}` : `org-${suffix}`;
}

/**
 * Create the owner: a platform-admin user (admin plugin role, DESIGN §6.2), their password
 * (Better Auth `credential` account; hash it first with Better Auth's hasher), their organisation
 * and an `owner` membership, in one `BEGIN IMMEDIATE` transaction. SQLite's write lock makes the
 * "no users yet" check and the insert a single step, so two concurrent claims (two tabs, or the
 * primary and a standby slot) cannot both succeed. Returns the new user's id.
 */
export function claimInstance(
	sqlite: Database,
	input: Omit<ClaimInput, 'password'> & { passwordHash: string },
	now = new Date(),
): { userId: string; organizationId: string } {
	const userId = randomBytes(24).toString('base64url');
	const organizationId = `org_${randomUUID().replaceAll('-', '')}`;
	const at = now.toISOString();
	sqlite
		.transaction(() => {
			if (sqlite.query('SELECT 1 FROM user LIMIT 1').get()) throw new SetupAlreadyCompleteError();
			sqlite.run(
				`INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, role)
				 VALUES (?, ?, ?, 1, NULL, ?, ?, 'admin')`,
				[userId, input.name, input.email, at, at],
			);
			sqlite.run(
				`INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
				 VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
				[randomBytes(24).toString('base64url'), userId, userId, input.passwordHash, at, at],
			);
			sqlite.run('INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)', [
				organizationId,
				input.organizationName,
				organizationSlug(input.organizationName),
				at,
			]);
			sqlite.run('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)', [
				`mem_${randomUUID().replaceAll('-', '')}`,
				organizationId,
				userId,
				'owner',
				at,
			]);
		})
		.immediate();
	return { userId, organizationId };
}
