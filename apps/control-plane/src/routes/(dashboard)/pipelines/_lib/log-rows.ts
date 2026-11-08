import type { PipelineConclusion, PipelineJobView, PipelineLogLine } from '@skiff/contracts';

/**
 * Turns a job's raw log lines into display rows: one header per step, `::group::` blocks that
 * collapse, and `::error::` / `::warning::` annotations picked out. ANSI escapes are stripped.
 */

export type LogLevel = 'error' | 'warning' | 'notice' | 'debug' | null;

type Parsed =
	| { kind: 'text'; text: string; level: LogLevel }
	| { kind: 'group'; title: string }
	| { kind: 'endgroup' }
	| { kind: 'hidden' };

// eslint-disable-next-line no-control-regex -- matching terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

const HIDDEN = new Set([
	'add-mask',
	'set-output',
	'save-state',
	'set-env',
	'add-path',
	'stop-commands',
	'add-matcher',
	'remove-matcher',
	'echo'
]);

/** `file=src/a.ts,line=3,col=7` → `src/a.ts:3:7` */
function location(props: string | undefined): string {
	if (!props) return '';
	const map = Object.fromEntries(
		props.split(',').map((pair) => {
			const at = pair.indexOf('=');
			return at < 0 ? [pair.trim(), ''] : [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
		})
	);
	const file = map.file ?? '';
	if (!file) return map.title ? `${map.title}: ` : '';
	return `${[file, map.line, map.col].filter(Boolean).join(':')}: `;
}

export function parseLine(raw: string): Parsed {
	const text = stripAnsi(raw);
	const command = /^::([a-z-]+)(?:\s+([^:]*))?::(.*)$/.exec(text) ?? /^##\[([a-z-]+)\]()(.*)$/.exec(text);
	if (!command) return { kind: 'text', text, level: null };
	const [, name, props, message = ''] = command;
	switch (name) {
		case 'group':
			return { kind: 'group', title: message || 'Group' };
		case 'endgroup':
			return { kind: 'endgroup' };
		case 'error':
		case 'warning':
		case 'notice':
			return { kind: 'text', text: `${location(props)}${message}`, level: name };
		case 'debug':
			return { kind: 'text', text: message, level: 'debug' };
	}
	if (name && HIDDEN.has(name)) return { kind: 'hidden' };
	return { kind: 'text', text, level: null };
}

interface TextItem {
	seq: number;
	n: number;
	text: string;
	level: LogLevel;
	stream: PipelineLogLine['stream'];
}

interface Section {
	step: number;
	items: Array<{ type: 'line'; line: TextItem } | { type: 'group'; id: string; title: string; lines: TextItem[] }>;
	count: number;
	errors: number;
}

/** Steps after the last real step: `-1` lines that arrive after any step output. */
export const SETUP_STEP = -1;
export const TEARDOWN_STEP = -2;

/** Parse once per batch of lines; the result is independent of open/closed state. */
export function sectionize(lines: PipelineLogLine[]): Map<number, Section> {
	const sections = new Map<number, Section>();
	const openGroups = new Map<number, Extract<Section['items'][number], { type: 'group' }>>();
	let sawStep = false;
	for (const line of lines) {
		let step = line.step;
		if (step >= 0) sawStep = true;
		else if (sawStep) step = TEARDOWN_STEP;
		let section = sections.get(step);
		if (!section) {
			section = { step, items: [], count: 0, errors: 0 };
			sections.set(step, section);
		}
		const parsed = parseLine(line.text);
		if (parsed.kind === 'hidden') continue;
		if (parsed.kind === 'group') {
			const group = { type: 'group' as const, id: `${step}:${line.seq}`, title: parsed.title, lines: [] };
			section.items.push(group);
			openGroups.set(step, group);
			continue;
		}
		if (parsed.kind === 'endgroup') {
			openGroups.delete(step);
			continue;
		}
		section.count += 1;
		if (parsed.level === 'error') section.errors += 1;
		const item: TextItem = {
			seq: line.seq,
			n: section.count,
			text: parsed.text,
			level: parsed.level,
			stream: line.stream
		};
		const group = openGroups.get(step);
		if (group) group.lines.push(item);
		else section.items.push({ type: 'line', line: item });
	}
	return sections;
}

export type LogRow =
	| {
			kind: 'step';
			key: string;
			step: number;
			name: string;
			status: string;
			conclusion: PipelineConclusion | null;
			startedAt: string | null;
			finishedAt: string | null;
			count: number;
			open: boolean;
	  }
	| { kind: 'group'; key: string; id: string; title: string; count: number; open: boolean }
	| { kind: 'line'; key: string; n: number; text: string; level: LogLevel; stream: string; nested: boolean }
	| { kind: 'empty'; key: string; text: string };

/** Setup/teardown pseudo-steps take their state from the job. */
function pseudoStep(job: PipelineJobView, step: number) {
	const started = job.steps.some((item) => item.status !== 'pending');
	if (step === SETUP_STEP) {
		if (started) return { status: 'completed', conclusion: 'success' as PipelineConclusion };
		return job.status === 'completed'
			? { status: 'completed', conclusion: job.conclusion }
			: { status: job.status === 'in_progress' ? 'in_progress' : 'pending', conclusion: null };
	}
	return job.status === 'completed'
		? { status: 'completed', conclusion: 'success' as PipelineConclusion }
		: { status: 'in_progress', conclusion: null };
}

export function buildRows(
	job: PipelineJobView,
	sections: Map<number, Section>,
	stepOpen: (step: number, failedOrRunning: boolean) => boolean,
	groupOpen: (id: string) => boolean
): LogRow[] {
	const order: number[] = [];
	if (sections.has(SETUP_STEP)) order.push(SETUP_STEP);
	const indices = new Set(job.steps.map((step) => step.index));
	for (const key of sections.keys()) if (key >= 0) indices.add(key);
	order.push(...[...indices].sort((a, b) => a - b));
	if (sections.has(TEARDOWN_STEP)) order.push(TEARDOWN_STEP);

	const rows: LogRow[] = [];
	for (const index of order) {
		const view = job.steps.find((step) => step.index === index);
		const state =
			index < 0
				? pseudoStep(job, index)
				: { status: view?.status ?? 'pending', conclusion: view?.conclusion ?? null };
		const section = sections.get(index);
		const hot =
			state.status === 'in_progress' ||
			state.conclusion === 'failure' ||
			state.conclusion === 'timed_out' ||
			(section?.errors ?? 0) > 0;
		const open = stepOpen(index, hot);
		rows.push({
			kind: 'step',
			key: `s${index}`,
			step: index,
			name:
				index === SETUP_STEP
					? 'Set up job'
					: index === TEARDOWN_STEP
						? 'Complete job'
						: (view?.name ?? `Step ${index + 1}`),
			status: state.status,
			conclusion: state.conclusion,
			startedAt: view?.startedAt ?? null,
			finishedAt: view?.finishedAt ?? null,
			count: section?.count ?? 0,
			open
		});
		if (!open) continue;
		if (!section || section.count === 0) {
			rows.push({
				kind: 'empty',
				key: `e${index}`,
				text: state.status === 'pending' ? 'Not started.' : state.status === 'in_progress' ? 'Waiting for output…' : 'No output.'
			});
			continue;
		}
		for (const item of section.items) {
			if (item.type === 'line') {
				rows.push({ kind: 'line', key: `l${item.line.seq}`, ...lineFields(item.line), nested: false });
				continue;
			}
			const expanded = groupOpen(item.id);
			rows.push({ kind: 'group', key: `g${item.id}`, id: item.id, title: item.title, count: item.lines.length, open: expanded });
			if (expanded)
				for (const line of item.lines)
					rows.push({ kind: 'line', key: `l${line.seq}`, ...lineFields(line), nested: true });
		}
	}
	return rows;
}

function lineFields(line: TextItem) {
	return { n: line.n, text: line.text, level: line.level, stream: line.stream };
}
