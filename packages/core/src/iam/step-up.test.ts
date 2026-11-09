import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	STEP_UP_WINDOW_MS,
	StepUpRequiredError,
	type Principal,
	type StepUpVerification,
} from '@yoal/contracts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import { stepUpEnabled } from './step-up.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-step-up-'));
const opened = createDb({ path: ':memory:' });
const org = { type: 'org' } as const;
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;

function open(): Core {
	return createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => now,
		},
	});
}

function principal(
	overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {},
	verification?: StepUpVerification,
): Principal {
	const built = buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...overrides,
	});
	if (verification) built.verification = verification;
	return built;
}

/** Run a check and return the error it threw, so its fields can be asserted. */
function caught(run: () => void): unknown {
	try {
		run();
		return undefined;
	} catch (error) {
		return error;
	}
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
		DELETE FROM member;
	`);
	core = open();
	// The suite drives the flag explicitly; `bun test` and headless runs leave it unset.
	delete process.env.YOAL_STEP_UP;
});

afterAll(() => {
	delete process.env.YOAL_STEP_UP;
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('step-up enforcement flag', () => {
	test('is off unless YOAL_STEP_UP=1', () => {
		expect(stepUpEnabled({})).toBe(false);
		expect(stepUpEnabled({ YOAL_STEP_UP: '0' })).toBe(false);
		expect(stepUpEnabled({ YOAL_STEP_UP: 'true' })).toBe(false);
		expect(stepUpEnabled({ YOAL_STEP_UP: '1' })).toBe(true);
	});

	test('with the flag off, a window permission needs no verification', () => {
		expect(() => core.ctx.iam.require(principal(), 'database:credentials', org)).not.toThrow();
	});

	test('with the flag on, a window permission without verification is denied', () => {
		process.env.YOAL_STEP_UP = '1';
		const error = caught(() =>
			core.ctx.iam.require(principal(), 'database:credentials', org),
		);
		expect(error).toBeInstanceOf(StepUpRequiredError);
		expect((error as StepUpRequiredError).permission).toBe('database:credentials');
		expect((error as StepUpRequiredError).level).toBe('window');
	});
});

describe('step-up window', () => {
	beforeEach(() => {
		process.env.YOAL_STEP_UP = '1';
	});

	test('a fresh verification of the strongest class is allowed', () => {
		const verified = principal({}, { at: now - 60_000, class: 'strong', strongest: 'strong' });
		expect(() => core.ctx.iam.require(verified, 'database:credentials', org)).not.toThrow();

		const basicOnly = principal({}, { at: now - 60_000, class: 'basic', strongest: 'basic' });
		expect(() => core.ctx.iam.require(basicOnly, 'database:credentials', org)).not.toThrow();
	});

	test('a stale verification is denied at the window edge', () => {
		const stale = principal(
			{},
			{ at: now - STEP_UP_WINDOW_MS, class: 'strong', strongest: 'strong' },
		);
		expect(caught(() => core.ctx.iam.require(stale, 'database:credentials', org))).toBeInstanceOf(
			StepUpRequiredError,
		);
	});

	test('a basic verification is not enough once a strong factor is enrolled', () => {
		const underVerified = principal({}, { at: now - 60_000, class: 'basic', strongest: 'strong' });
		expect(
			caught(() => core.ctx.iam.require(underVerified, 'database:credentials', org)),
		).toBeInstanceOf(StepUpRequiredError);
	});

	test('a permission with no step-up level is never challenged', () => {
		expect(() => core.ctx.iam.require(principal(), 'database:read', org)).not.toThrow();
	});
});

describe('step-up levels', () => {
	beforeEach(() => {
		process.env.YOAL_STEP_UP = '1';
	});

	test('always asks every time, even with a fresh verification', () => {
		const verified = principal({}, { at: now - 60_000, class: 'strong', strongest: 'strong' });
		const error = caught(() => core.ctx.iam.require(verified, 'org:delete', org));
		expect(error).toBeInstanceOf(StepUpRequiredError);
		expect((error as StepUpRequiredError).level).toBe('always');
	});

	test('machine credentials are not challenged; they follow the token rule instead', () => {
		// An API key cannot show a dialog (STEP-UP.md §7), so it is not gated by the session window.
		const key = principal({ kind: 'apiKey' });
		expect(() => core.ctx.iam.require(key, 'database:credentials', org)).not.toThrow();
	});
});
