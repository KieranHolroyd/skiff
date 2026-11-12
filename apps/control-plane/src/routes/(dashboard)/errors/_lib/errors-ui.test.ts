import { describe, expect, mock, test } from 'bun:test';
import type { AppErrorFrameView, AppErrorTargetView } from '@yoal/contracts';

mock.module('$app/paths', () => ({ resolve: (path: string) => path.replace('/(dashboard)', '') }));
const {
	activeFilters,
	dayLabels,
	frameRuns,
	issuesHref,
	hourLabels,
	isNew,
	isRegressed,
	stackText,
	targetHealth
} = await import('./issue-ui.js');
const { SDKS, sdkById, storeCurl } = await import('./sdks.js');
const { errorsSubnav, readErrorsTab } = await import('./subnav.js');

const DSN = 'https://0123456789abcdef0123456789abcdef@control.test/ingest/7';
const base = {
	dsn: DSN,
	environment: 'production',
	release: 'web@1.0.0',
	injected: false,
	origin: 'https://control.test/'
};

function frame(fn: string, inApp: boolean): AppErrorFrameView {
	return { fn, file: `${fn}.ts`, line: 1, column: 2, inApp };
}

function target(overrides: Partial<AppErrorTargetView> = {}): AppErrorTargetView {
	return {
		id: 'p1',
		kind: 'project',
		name: 'Web',
		projectId: 'p1',
		projectSlug: 'web',
		dsnProjectId: 7,
		dsn: DSN,
		publicKey: '0123456789abcdef0123456789abcdef',
		enabled: true,
		autoLinked: false,
		sampleRate: 1,
		notify: true,
		usage: { month: '2026-11', accepted: 0, dropped: 0, ignored: 0, limit: 100_000 },
		unresolved: 0,
		events24h: 0,
		lastSeenAt: null,
		firstSeenAt: null,
		daily: [0, 0, 0, 0, 0, 0, 0],
		...overrides
	};
}

describe('SDK snippets', () => {
	test('every snippet carries the DSN and the tags it was given', () => {
		for (const sdk of SDKS) {
			const code = sdk.init(base);
			expect(code).toContain(DSN);
			expect(code).toContain('production');
			expect(code).toContain('web@1.0.0');
		}
	});

	test('empty tags are left out rather than written as empty strings', () => {
		for (const sdk of SDKS) {
			const code = sdk.init({ ...base, environment: ' ', release: '' });
			expect(code).not.toContain("''");
			expect(code).not.toContain('""');
			expect(code).not.toMatch(/environment|release/i);
		}
	});

	test('server SDKs read the injected DSN instead of embedding it', () => {
		for (const sdk of SDKS.filter((item) => item.server)) {
			const code = sdk.init({ ...base, injected: true });
			expect(code).not.toContain(DSN);
			expect(code).toContain('SENTRY_DSN');
		}
	});

	test('the static snippet points at e.js on the platform origin', () => {
		expect(sdkById('static').init(base)).toStartWith('<script src="https://control.test/e.js"');
	});

	test('an unknown id falls back to the first SDK', () => {
		expect(sdkById('cobol').id).toBe(SDKS[0]!.id);
	});
});

describe('storeCurl', () => {
	test('targets the store endpoint with query-string auth', () => {
		const curl = storeCurl(DSN)!;
		expect(curl).toContain(
			"'https://control.test/ingest/api/7/store/?sentry_key=0123456789abcdef0123456789abcdef&sentry_version=7'"
		);
		expect(curl).toContain('Hello from curl');
	});

	test('refuses a placeholder or missing DSN', () => {
		expect(storeCurl(null)).toBeNull();
		expect(storeCurl('https://<key>@<platform>/ingest/<id>')).toBeNull();
		expect(storeCurl('not a url')).toBeNull();
	});
});

describe('targetHealth', () => {
	const now = Date.UTC(2026, 10, 12, 12);
	test('reads disabled, reporting, quiet and waiting', () => {
		expect(targetHealth(target({ enabled: false, lastSeenAt: now }), now).label).toBe('Disabled');
		expect(targetHealth(target({ lastSeenAt: now - 1000 }), now)).toMatchObject({
			label: 'Reporting',
			live: true
		});
		expect(targetHealth(target({ lastSeenAt: now - 2 * 86_400_000 }), now).label).toBe('Quiet');
		expect(targetHealth(target(), now).label).toBe('Waiting for first event');
	});
});

describe('issue flags', () => {
	const now = Date.UTC(2026, 10, 12, 12);
	test('new means first seen in the last day', () => {
		expect(isNew({ firstSeenAt: now - 3_600_000 }, now)).toBe(true);
		expect(isNew({ firstSeenAt: now - 2 * 86_400_000 }, now)).toBe(false);
	});

	test('regressed only while still unresolved', () => {
		expect(isRegressed({ regressedAt: now, status: 'unresolved' })).toBe(true);
		expect(isRegressed({ regressedAt: now, status: 'resolved' })).toBe(false);
		expect(isRegressed({ regressedAt: null, status: 'unresolved' })).toBe(false);
	});
});

describe('chart labels', () => {
	const now = Date.UTC(2026, 10, 12, 15, 30);
	test('days end today, oldest first', () => {
		expect(dayLabels(3, now)).toEqual(['10 Nov', '11 Nov', 'Today']);
	});

	test('hours end with the current hour', () => {
		expect(hourLabels(2, now)).toEqual(['14:00 UTC', 'This hour']);
	});
});

describe('frameRuns', () => {
	test('folds each run of library frames between in-app frames', () => {
		const runs = frameRuns([
			frame('a', true),
			frame('b', false),
			frame('c', false),
			frame('d', true),
			frame('e', false)
		]);
		expect(
			runs.map((run) =>
				run.kind === 'app' ? run.frame.fn : run.frames.map((item) => item.fn).join('+')
			)
		).toEqual(['a', 'b+c', 'd', 'e']);
	});

	test('shows a stack with no in-app frames whole', () => {
		expect(
			frameRuns([frame('a', false), frame('b', false)]).every((run) => run.kind === 'app')
		).toBe(true);
	});

	test('stackText writes one frame per line', () => {
		expect(stackText([{ type: 'TypeError', value: 'boom', frames: [frame('a', true)] }])).toBe(
			'TypeError: boom\n  at a (a.ts:1:2)'
		);
	});
});

describe('errors subnav', () => {
	test('an organization with no targets lands on Setup', () => {
		expect(readErrorsTab(null, 0)).toBe('setup');
		expect(readErrorsTab(null, 2)).toBe('issues');
		expect(readErrorsTab('targets', 0)).toBe('targets');
		expect(readErrorsTab('nope', null)).toBe('issues');
	});

	test('counts unresolved issues and targets, and pulses Setup until the first event', () => {
		const waiting = errorsSubnav({
			tab: 'setup',
			service: { targets: [{ lastSeenAt: null }], summary: { unresolved: 0 } }
		});
		const items = waiting.groups[0]!.items;
		expect(waiting.active).toBe('setup');
		expect(items.find((item) => item.id === 'issues')?.count).toBeUndefined();
		expect(items.find((item) => item.id === 'targets')?.count).toBe(1);
		expect(items.find((item) => item.id === 'setup')?.live).toBeTruthy();

		const reporting = errorsSubnav({
			tab: 'issues',
			service: { targets: [{ lastSeenAt: 1 }], summary: { unresolved: 4 } }
		});
		expect(reporting.groups[0]!.items.find((item) => item.id === 'issues')?.count).toBe(4);
		expect(reporting.groups[0]!.items.find((item) => item.id === 'setup')?.live).toBeUndefined();
	});
});

describe('issuesHref', () => {
	const filters = {
		status: 'unresolved',
		level: 'error',
		environment: '',
		release: '',
		target: 'p1',
		q: 'boom',
		range: 'all',
		sort: 'last_seen',
		offset: 50
	};

	test('keeps filters, drops defaults, paging and the open issue', () => {
		expect(issuesHref(filters)).toBe('?tab=issues&target=p1&level=error&q=boom');
	});

	test('applies overrides and drops a filter set to null', () => {
		expect(issuesHref(filters, { status: 'resolved', level: null, issue: 'iss_1' })).toBe(
			'?tab=issues&status=resolved&target=p1&q=boom&issue=iss_1'
		);
		expect(issuesHref(filters, { offset: 100 })).toBe(
			'?tab=issues&target=p1&level=error&q=boom&offset=100'
		);
	});

	test('chips name the target rather than its id', () => {
		expect(
			activeFilters(filters, () => 'Web').map((chip) => `${chip.label}:${chip.value}`)
		).toEqual(['Search:boom', 'Target:Web', 'Level:error']);
	});
});
