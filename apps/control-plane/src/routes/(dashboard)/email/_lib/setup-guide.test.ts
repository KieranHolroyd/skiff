import { describe, expect, test } from 'bun:test';
import {
	judgeReverseDns,
	sentFromApp,
	setupProgress,
	setupStepIds,
	setupSteps,
	type SetupFacts
} from './setup-guide.js';

const nothing: SetupFacts = {
	nodeChosen: false,
	reverseDns: null,
	domains: 0,
	verifiedDomains: 0,
	delivered: false,
	credentials: 0,
	appSent: false,
	orgState: 'sandbox'
};

const everything: SetupFacts = {
	nodeChosen: true,
	reverseDns: 'ok',
	domains: 1,
	verifiedDomains: 1,
	delivered: true,
	credentials: 1,
	appSent: true,
	orgState: 'active'
};

const states = (facts: SetupFacts) =>
	Object.fromEntries(setupSteps(facts).map((step) => [step.id, step.state]));

describe('setup steps', () => {
	test('a fresh platform points at the mail node first', () => {
		const steps = setupSteps(nothing);
		expect(steps.map((step) => step.id)).toEqual([...setupStepIds]);
		expect(steps[0]).toMatchObject({ id: 'node', state: 'current', owner: 'platform' });
		expect(steps.slice(1).every((step) => step.state === 'upcoming')).toBe(true);
	});

	test('exactly one step is current, the first one not done', () => {
		const result = states({ ...nothing, nodeChosen: true, reverseDns: 'ok', domains: 1 });
		expect(result).toMatchObject({
			node: 'done',
			'reverse-dns': 'done',
			domain: 'done',
			verify: 'current',
			test: 'upcoming'
		});
	});

	test('steps finished out of order stay done', () => {
		const result = states({ ...nothing, domains: 2, credentials: 1 });
		expect(result.node).toBe('current');
		expect(result.domain).toBe('done');
		expect(result.connect).toBe('done');
	});

	test('reverse DNS only counts when the round trip checks out', () => {
		for (const reverseDns of [null, 'missing', 'mismatch', 'unknown'] as const)
			expect(states({ ...everything, reverseDns })['reverse-dns']).toBe('current');
	});

	test('connecting an app is done by a credential or by mail sent outside the dashboard', () => {
		expect(states({ ...everything, credentials: 0, appSent: false }).connect).toBe('current');
		expect(states({ ...everything, credentials: 0, appSent: true }).connect).toBe('done');
	});

	test('a paused or sandboxed organisation has not left the sandbox', () => {
		expect(states({ ...everything, orgState: 'sandbox' }).sandbox).toBe('current');
		expect(states({ ...everything, orgState: 'paused' }).sandbox).toBe('current');
		expect(states({ ...everything, orgState: null }).sandbox).toBe('current');
	});

	test('progress counts done steps', () => {
		expect(setupProgress(setupSteps(nothing))).toMatchObject({ done: 0, complete: false, percent: 0 });
		const all = setupProgress(setupSteps(everything));
		expect(all).toEqual({ done: setupStepIds.length, total: setupStepIds.length, complete: true, percent: 100 });
	});
});

describe('sent from an app', () => {
	test('dashboard tests do not count; SMTP, bindings and other API sends do', () => {
		expect(sentFromApp([])).toBe(false);
		expect(sentFromApp([{ source: 'api', tags: { source: 'dashboard-test' } }])).toBe(false);
		expect(sentFromApp([{ source: 'api', tags: {} }])).toBe(true);
		expect(sentFromApp([{ source: 'smtp', tags: {} }])).toBe(true);
		expect(sentFromApp([{ source: 'binding', tags: {} }])).toBe(true);
	});
});

describe('reverse DNS', () => {
	const base = { ip: '203.0.113.7', helo: 'mx1.example.com' };

	test('PTR naming the HELO host that resolves back is ok, ignoring case and the root dot', () => {
		expect(judgeReverseDns({ ...base, ptr: ['MX1.example.com.'], forward: ['203.0.113.7'] })).toBe('ok');
	});

	test('no PTR is missing; the provider default name is a mismatch', () => {
		expect(judgeReverseDns({ ...base, ptr: [], forward: null })).toBe('missing');
		expect(
			judgeReverseDns({ ...base, ptr: ['7-113-0-203.instances.example.net'], forward: ['203.0.113.7'] })
		).toBe('mismatch');
	});

	test('the HELO host pointing elsewhere is a mismatch', () => {
		expect(judgeReverseDns({ ...base, ptr: ['mx1.example.com'], forward: ['198.51.100.1'] })).toBe(
			'mismatch'
		);
	});

	test('failed lookups are unknown, not a verdict', () => {
		expect(judgeReverseDns({ ...base, ptr: null, forward: null })).toBe('unknown');
		expect(judgeReverseDns({ ...base, ptr: ['mx1.example.com'], forward: null })).toBe('unknown');
	});
});
