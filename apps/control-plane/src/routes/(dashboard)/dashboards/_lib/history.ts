import type { PanelQuery } from '@skiff/contracts';

/** Explore's recent queries, per browser. Storage can be missing or full; that just means no history. */
const KEY = 'skiff.observability.explore-history';
const LIMIT = 30;

export interface HistoryEntry {
	at: number;
	query: PanelQuery;
}

export function readHistory(): HistoryEntry[] {
	try {
		const raw = localStorage.getItem(KEY);
		const list = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
		return Array.isArray(list)
			? list.filter((entry) => entry && typeof entry.at === 'number' && entry.query)
			: [];
	} catch {
		return [];
	}
}

export function pushHistory(query: PanelQuery): HistoryEntry[] {
	const text = JSON.stringify(query);
	const next = [
		{ at: Date.now(), query },
		...readHistory().filter((entry) => JSON.stringify(entry.query) !== text)
	].slice(0, LIMIT);
	try {
		localStorage.setItem(KEY, JSON.stringify(next));
	} catch {
		// Private mode or quota: keep it in memory only.
	}
	return next;
}

export function clearHistory(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		// ignore
	}
}
