import { describe, expect, test } from 'bun:test';
import {
	LiveRegion,
	ProgressTracker,
	confirmQuestion,
	exitCodeFor,
	failureLine,
	formatDurationShort,
	outcomeLine,
	phaseLine,
	planSummaryLine,
	planTable,
	progressBar,
	progressLine,
	progressLines,
	pruneConfirmQuestion,
	pruneTable,
	type OperationItemView,
	type OperationView,
} from './operations.ts';

function item(overrides: Partial<OperationItemView> & { seq: number }): OperationItemView {
	return {
		category: null,
		targetKind: 'project',
		targetId: `prj_${overrides.seq}`,
		label: `p-${overrides.seq}`,
		verdict: 'ok',
		reason: null,
		flags: [],
		status: 'pending',
		error: null,
		bytes: null,
		...overrides,
	};
}

function view(overrides: Partial<OperationView> = {}): OperationView {
	return {
		id: 'op_1',
		kind: 'bulk',
		action: 'project.delete',
		status: 'applying',
		scope: null,
		phase: null,
		total: 0,
		done: 0,
		failed: 0,
		summary: { verdicts: {}, statuses: {}, flags: {}, freedBytes: 0 },
		createdAt: '2026-11-04T12:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		planExpiresAt: null,
		...overrides,
	};
}

describe('exitCodeFor', () => {
	test('0 succeeded, 3 partial, 1 for the rest', () => {
		expect(exitCodeFor('succeeded')).toBe(0);
		expect(exitCodeFor('partial')).toBe(3);
		expect(exitCodeFor('failed')).toBe(1);
		expect(exitCodeFor('cancelled')).toBe(1);
		expect(exitCodeFor('expired')).toBe(1);
	});
});

describe('plan formatting', () => {
	const items = [
		item({ seq: 1, label: 'blog', flags: ['live', 'custom_domain'] }),
		item({ seq: 2, label: 'test-a' }),
		item({ seq: 3, label: 'api', flags: ['live', 'workload'] }),
		item({ seq: 4, label: 'gone', verdict: 'skip', reason: 'not_found', status: 'skipped' }),
		item({ seq: 5, label: 'theirs', verdict: 'blocked', reason: 'forbidden', status: 'skipped' }),
	];

	test('plan table shows slug, verdict, flags and reason', () => {
		expect(planTable(items).split('\n')).toEqual([
			'SLUG    VERDICT  FLAGS               REASON',
			'------  -------  ------------------  ---------',
			'blog    ok       live,custom_domain  -',
			'test-a  ok       -                   -',
			'api     ok       live,workload       -',
			'gone    skip     -                   not found',
			'theirs  blocked  -                   forbidden',
		]);
	});

	test('summary line counts verdicts and flags on ok items', () => {
		expect(planSummaryLine('project.delete', items)).toBe(
			'3 to delete (2 live, 1 custom domain, 1 workload), 1 skipped, 1 blocked',
		);
	});

	test('confirm questions per action', () => {
		const ok = items.filter((entry) => entry.verdict === 'ok');
		expect(confirmQuestion('project.delete', ok)).toBe(
			'Delete 3 projects (2 live)? They stay restorable for 7 days. [y/N] ',
		);
		expect(confirmQuestion('project.restore', ok.slice(1, 2))).toBe('Restore 1 project? [y/N] ');
		expect(confirmQuestion('project.purge', ok.slice(1, 2))).toBe(
			'Permanently delete 1 project? This cannot be undone. [y/N] ',
		);
	});
});

describe('prune formatting', () => {
	const summary = {
		verdicts: { ok: 7 },
		statuses: {},
		flags: {},
		freedBytes: 0,
		categories: {
			releases: { planned: 4, bytes: 48 * 1024 * 1024, succeeded: 0, failed: 0, skipped: 0 },
			project_rows: { planned: 3, bytes: 0, succeeded: 0, failed: 0, skipped: 0 },
			domains: { planned: 0, bytes: 0, succeeded: 0, failed: 0, skipped: 0 },
		},
	};

	test('per-category table in registry order, hiding empty categories, with a total', () => {
		expect(pruneTable(summary).split('\n')).toEqual([
			'CATEGORY                          ITEMS  SIZE',
			'--------------------------------  -----  ------',
			'Project leftovers (project_rows)  3      -',
			'Unused releases (releases)        4      48 MiB',
			'Total                             7      48 MiB',
		]);
	});

	test('confirm question totals items and bytes', () => {
		expect(pruneConfirmQuestion(summary)).toBe('Prune 7 items (48 MiB)? This cannot be undone. [y/N] ');
	});
});

describe('progress rendering', () => {
	test('progress bar fills proportionally and clamps', () => {
		expect(progressBar(384, 480)).toBe('▕████████░░▏');
		expect(progressBar(0, 10)).toBe('▕░░░░░░░░░░▏');
		expect(progressBar(12, 10)).toBe('▕██████████▏');
		expect(progressBar(0, 0)).toBe('▕██████████▏');
	});

	test('a category line with bytes and failures', () => {
		expect(progressLine({ key: 'releases', done: 384, total: 480, bytes: 46 * 1024 * 1024, failed: 0 })).toBe(
			'releases ▕████████░░▏ 384/480 · 46 MiB',
		);
		expect(progressLine({ key: 'delete', done: 2, total: 4, bytes: 0, failed: 1 })).toBe(
			'delete ▕█████░░░░░▏ 2/4 · 1 failed',
		);
	});

	test('lines align their keys', () => {
		expect(
			progressLines([
				{ key: 'domains', done: 1, total: 1, bytes: 0, failed: 0 },
				{ key: 'releases', done: 0, total: 2, bytes: 0, failed: 0 },
			]),
		).toEqual(['domains  ▕██████████▏ 1/1', 'releases ▕░░░░░░░░░░▏ 0/2']);
	});

	test('phase lines for plain output', () => {
		expect(phaseLine(view({ status: 'planning', phase: 'Scanning unused releases' }))).toBe(
			'planning: Scanning unused releases',
		);
		expect(phaseLine(view({ status: 'applying', phase: 'releases', done: 3, total: 9, failed: 1 }))).toBe(
			'applying: releases 3/9, 1 failed',
		);
	});

	test('failure and outcome lines', () => {
		expect(failureLine(item({ seq: 1, label: 'blog', status: 'failed', error: 'boom' }))).toBe('  failed  blog: boom');
		expect(
			outcomeLine(view({ status: 'partial', summary: { verdicts: {}, statuses: { succeeded: 3, failed: 1, skipped: 1 }, flags: {}, freedBytes: 0 } })),
		).toBe('Partial: 3 succeeded, 1 failed, 1 skipped.');
		expect(
			outcomeLine(
				view({ kind: 'prune', status: 'succeeded', summary: { verdicts: {}, statuses: { succeeded: 2 }, flags: {}, freedBytes: 2048 } }),
			),
		).toBe('Succeeded: 2 succeeded. Freed 2.0 KiB.');
	});

	test('short durations', () => {
		expect(formatDurationShort(-5)).toBe('due');
		expect(formatDurationShort(30_000)).toBe('<1m');
		expect(formatDurationShort(5 * 60_000)).toBe('5m');
		expect(formatDurationShort((5 * 60 + 12) * 60_000)).toBe('5h 12m');
		expect(formatDurationShort((6 * 24 + 23) * 60 * 60_000 + 59_000)).toBe('6d 23h');
		expect(formatDurationShort(7 * 24 * 60 * 60_000)).toBe('7d');
	});
});

describe('ProgressTracker', () => {
	test('bulk: one row from the operation counters; collects failures and succeeded labels', () => {
		const tracker = new ProgressTracker(view({ total: 3 }));
		const failures = tracker.items([
			item({ seq: 1, label: 'a', status: 'succeeded' }),
			item({ seq: 2, label: 'b', status: 'failed', error: 'nope' }),
			item({ seq: 3, label: 'c', verdict: 'skip', status: 'skipped' }),
		]);
		expect(failures.map((entry) => entry.label)).toEqual(['b']);
		expect(tracker.succeeded).toEqual(['a']);
		tracker.update(view({ total: 3, done: 2, failed: 1 }));
		expect(tracker.rows()).toEqual([{ key: 'delete', done: 2, total: 3, bytes: 0, failed: 1 }]);
	});

	test('prune: one row per planned category with bytes freed so far', () => {
		const tracker = new ProgressTracker(
			view({
				kind: 'prune',
				action: 'prune',
				summary: {
					verdicts: {},
					statuses: {},
					flags: {},
					freedBytes: 0,
					categories: {
						releases: { planned: 2, bytes: 300, succeeded: 0, failed: 0, skipped: 0 },
						domains: { planned: 1, bytes: 0, succeeded: 0, failed: 0, skipped: 0 },
					},
				},
			}),
		);
		tracker.items([
			item({ seq: 1, category: 'domains', status: 'succeeded' }),
			item({ seq: 2, category: 'releases', status: 'succeeded', bytes: 100 }),
		]);
		expect(tracker.rows()).toEqual([
			{ key: 'domains', done: 1, total: 1, bytes: 0, failed: 0 },
			{ key: 'releases', done: 1, total: 2, bytes: 100, failed: 0 },
		]);
	});
});

describe('LiveRegion', () => {
	test('redraws in place and logs permanent lines above the region', () => {
		let out = '';
		const region = new LiveRegion((text) => {
			out += text;
		});
		region.render(['a', 'b']);
		expect(out).toBe('a\nb\n');
		out = '';
		region.render(['a', 'b']);
		expect(out).toBe('');
		region.render(['c']);
		expect(out).toBe('\x1b[2A\x1b[2K\n\x1b[2K\n\x1b[2Ac\n');
		out = '';
		region.log('failed x', ['d']);
		expect(out).toBe('\x1b[1A\x1b[2K\n\x1b[1Afailed x\nd\n');
		region.done();
		out = '';
		region.render(['e']);
		expect(out).toBe('e\n');
	});
});
