import type { Cell, Column, StudioEvent, StudioInfo } from '@yoal/studio/protocol';

/**
 * How one `run` stream becomes result tabs (plan 22). Each `columns` … `result` group is one
 * result set; a `result` with no open set (DML, DDL, a Redis reply without rows) still gets a
 * tab. Kept pure so the mapping is unit-tested without a browser.
 */
export interface ResultSet {
	id: number;
	columns: Column[];
	rows: Cell[][];
	affected?: number;
	command?: string;
}

export interface RunMessage {
	level: 'info' | 'warn' | 'error';
	text: string;
	/** A friendlier headline for known error codes. */
	title?: string;
	code?: string;
	/** 1-based character offset into the text that ran. */
	position?: number;
}

export interface RunState {
	results: ResultSet[];
	messages: RunMessage[];
	done: { ms: number; truncated: boolean } | null;
	/** Index of the result set still receiving rows. */
	open: number | null;
}

export function emptyRun(): RunState {
	return { results: [], messages: [], done: null, open: null };
}

export function applyEvent(state: RunState, event: StudioEvent): RunState {
	switch (event.t) {
		case 'columns': {
			const id = state.results.length;
			return {
				...state,
				results: [...state.results, { id, columns: event.columns, rows: [] }],
				open: id
			};
		}
		case 'rows': {
			if (state.open === null) return state;
			const open = state.open;
			return {
				...state,
				results: state.results.map((set) =>
					set.id === open ? { ...set, rows: set.rows.concat(event.rows) } : set
				)
			};
		}
		case 'result': {
			const extra = {
				...(event.affected === undefined ? {} : { affected: event.affected }),
				...(event.command === undefined ? {} : { command: event.command })
			};
			if (state.open === null) {
				const id = state.results.length;
				return { ...state, results: [...state.results, { id, columns: [], rows: [], ...extra }] };
			}
			const open = state.open;
			return {
				...state,
				results: state.results.map((set) => (set.id === open ? { ...set, ...extra } : set)),
				open: null
			};
		}
		case 'notice':
			return { ...state, messages: [...state.messages, { level: event.level, text: event.message }] };
		case 'error':
			return {
				...state,
				open: null,
				messages: [
					...state.messages,
					{
						level: 'error',
						text: event.message,
						code: event.code,
						...(errorTitle(event.code) ? { title: errorTitle(event.code) } : {}),
						...(event.position === undefined ? {} : { position: event.position })
					}
				]
			};
		case 'done':
			return { ...state, done: { ms: event.ms, truncated: event.truncated }, open: null };
		case 'page':
			return state;
	}
}

const numberFormat = new Intl.NumberFormat('en-GB');

/** "Result 1 · 250 rows · SELECT", "Result 2 · 3 affected · UPDATE", "Result 3 · OK". */
export function resultTitle(set: ResultSet): string {
	const parts = [`Result ${set.id + 1}`];
	if (set.columns.length > 0)
		parts.push(`${numberFormat.format(set.rows.length)} ${set.rows.length === 1 ? 'row' : 'rows'}`);
	else if (set.affected !== undefined) parts.push(`${numberFormat.format(set.affected)} affected`);
	const verb = set.command?.trim().split(/\s+/)[0];
	if (verb) parts.push(verb);
	if (parts.length === 1) parts.push('OK');
	return parts.join(' · ');
}

/** The effective row cap for a run: the user's choice, never above the session limit. */
export function rowCap(choice: number, info: StudioInfo): number {
	return Math.max(1, Math.min(choice, info.limits.maxRows));
}

/** Max-rows choices offered in the toolbar, capped at the session limit. */
export function rowChoices(info: StudioInfo): number[] {
	const limit = info.limits.maxRows;
	const choices = [100, 1_000, 10_000].filter((choice) => choice <= limit);
	if (!choices.includes(limit) && limit < 10_000) choices.push(limit);
	return choices.sort((a, b) => a - b);
}

/** Headlines for the protocol's error codes; `undefined` for codes whose message says it all. */
export function errorTitle(code: string): string | undefined {
	switch (code) {
		case 'read_only':
			return 'This session is read-only; enable writes in the header.';
		case 'timeout':
			return 'The statement ran past the session time limit and was cancelled.';
		case 'cancelled':
			return 'Stopped. The statement was cancelled on the database.';
		case 'studio_restarted':
			return 'The studio restarted; run again.';
		case 'session_expired':
			return 'The studio session expired; open a new session.';
		case 'unknown_session':
			return 'The studio session is gone; open a new session.';
		case 'busy':
			return 'Another statement is still running in this session.';
		case 'studio_unavailable':
			return 'The studio is not reachable right now.';
		case 'network':
			return 'The connection to the control plane broke off.';
		case 'bad_request':
			return 'The studio could not read this input.';
		default:
			return undefined;
	}
}
