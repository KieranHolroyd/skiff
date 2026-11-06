/**
 * Resources the composer can @-mention. Loaded lazily the first time the user types `@`, through
 * the same session-authenticated REST API the dashboard uses, so a user only sees what they can
 * read. The mention is inserted as plain text (`@launch-page`); the agents resolve it with tools.
 */

export interface MentionItem {
	kind: 'project' | 'database' | 'storage';
	name: string;
	detail?: string;
}

let cache: { at: number; items: MentionItem[] } | null = null;
let inflight: Promise<MentionItem[]> | null = null;
const TTL_MS = 60_000;

async function list<T>(url: string, key: string): Promise<T[]> {
	try {
		const response = await fetch(url, { headers: { accept: 'application/json' } });
		if (!response.ok) return [];
		const body = (await response.json()) as Record<string, unknown>;
		return Array.isArray(body[key]) ? (body[key] as T[]) : [];
	} catch {
		return [];
	}
}

export function loadMentions(): Promise<MentionItem[]> {
	if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.items);
	inflight ??= Promise.all([
		list<{ slug: string; name?: string; runtime?: string }>('/api/v1/projects', 'projects'),
		list<{ name: string; engineLabel?: string }>('/api/v1/databases', 'databases'),
		list<{ name: string; engineLabel?: string }>('/api/v1/storage', 'storage')
	])
		.then(([projects, databases, storage]) => {
			const items: MentionItem[] = [
				...projects.map((p) => ({
					kind: 'project' as const,
					name: p.slug,
					detail: p.name && p.name !== p.slug ? p.name : p.runtime
				})),
				...databases.map((d) => ({
					kind: 'database' as const,
					name: d.name,
					detail: d.engineLabel
				})),
				...storage.map((s) => ({ kind: 'storage' as const, name: s.name, detail: s.engineLabel }))
			];
			cache = { at: Date.now(), items };
			return items;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

export function filterMentions(items: MentionItem[], query: string, limit = 8): MentionItem[] {
	const q = query.toLowerCase();
	return items
		.map((item) => {
			const name = item.name.toLowerCase();
			const score = !q
				? 1
				: name.startsWith(q)
					? 3
					: name.includes(q)
						? 2
						: item.detail?.toLowerCase().includes(q)
							? 1
							: 0;
			return { item, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
		.slice(0, limit)
		.map((entry) => entry.item);
}
