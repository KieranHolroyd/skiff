import * as z from 'zod';
import { GUIDE_TOOL, SEARCH_TOOL } from './constants';
import type { AssistantTool } from './tools';

/**
 * Deferred tool loading (docs/ASSISTANT.md → Tool search). The MCP catalog is well over a hundred
 * tools; sending every schema on every model round costs more context than most turns need. So a
 * turn starts with a small core set plus `search_tools`, the prompt lists the remaining tools by
 * name only, and the model loads what it needs. Loaded tools are offered from the next round of
 * the same turn. Each turn starts fresh.
 *
 * This is a context optimisation, not a permission boundary: the catalog it searches is already
 * filtered to what the caller (and the owner's allowlist) permits, and every call still goes
 * through the same validation, confirmation and RBAC as before.
 */

/** Read tools most turns start from; everything else is one search away. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
	GUIDE_TOOL,
	'whoami',
	'search_docs',
	'read_docs',
	'list_projects',
	'get_project',
	'list_deployments',
	'get_deployment',
	'get_logs',
	'get_status',
	'list_databases',
	'get_database',
	'list_storage',
	'get_storage',
	'list_nodes'
]);

/** At or below this many tools, offer them all: deferral would only cost a round. */
export const DEFER_THRESHOLD = 40;

const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 15;

const searchSchema = z.object({
	query: z
		.string()
		.min(1)
		.max(500)
		.describe(
			'Keywords such as "queue redrive" or "database backup", or "select:name1,name2" to load exact tools by name. Prefix a word with + to require it in the tool name.'
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(MAX_RESULTS)
		.optional()
		.describe(`How many matches to load (default ${DEFAULT_RESULTS}).`)
});

function terms(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((term) => (term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term));
}

/** Rank tools for a keyword query. `select:a,b` returns exactly those tools, in that order. */
export function rankTools(
	catalog: readonly AssistantTool[],
	query: string,
	limit = DEFAULT_RESULTS
): AssistantTool[] {
	const trimmed = query.trim();
	if (trimmed.toLowerCase().startsWith('select:')) {
		const names = trimmed
			.slice('select:'.length)
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean);
		return names
			.map((name) => catalog.find((tool) => tool.name === name))
			.filter((tool): tool is AssistantTool => tool !== undefined)
			.slice(0, MAX_RESULTS);
	}

	const words = trimmed.split(/\s+/).filter(Boolean);
	const required = words.filter((word) => word.startsWith('+')).flatMap((word) => terms(word));
	const wanted = words.flatMap((word) => terms(word));
	if (wanted.length === 0) return [];

	const scored = catalog
		.map((tool) => {
			const nameTerms = terms(tool.name);
			const name = tool.name.toLowerCase();
			if (!required.every((term) => name.includes(term))) return { tool, score: 0 };
			const title = tool.title.toLowerCase();
			const description = tool.description.toLowerCase();
			let score = 0;
			for (const term of wanted) {
				if (nameTerms.includes(term)) score += 10;
				else if (name.includes(term)) score += 6;
				if (title.includes(term)) score += 3;
				if (description.includes(term)) score += 1;
			}
			return { tool, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
	return scored.slice(0, limit).map((entry) => entry.tool);
}

function firstSentence(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const end = flat.search(/[.!?](\s|$)/);
	const sentence = end === -1 ? flat : flat.slice(0, end + 1);
	return sentence.length > 200 ? `${sentence.slice(0, 200)}…` : sentence;
}

export interface Toolbox {
	/** Whether this turn defers tools at all; false when the catalog is small. */
	readonly deferring: boolean;
	/** The tools to send to the model this round. Changes after a search loads more. */
	offered(): AssistantTool[];
	/** A tool the model may call by name: loaded or not, as long as it is in the catalog. */
	find(name: string): AssistantTool | undefined;
	isLoaded(name: string): boolean;
	load(names: Iterable<string>): void;
	/** Bumps whenever `offered()` changes, so the caller can cache the provider schema list. */
	readonly version: number;
	/** A system-prompt section naming the deferred tools, or '' when nothing is deferred. */
	prompt(): string;
}

/**
 * Wrap a turn's tool catalog. With a small catalog (an owner allowlist, say) every tool is offered
 * and no search tool is added.
 */
export function createToolbox(catalog: readonly AssistantTool[]): Toolbox {
	const deferring = catalog.length > DEFER_THRESHOLD;
	const loaded = new Set(
		deferring
			? catalog.filter((tool) => CORE_TOOLS.has(tool.name)).map((tool) => tool.name)
			: catalog.map((tool) => tool.name)
	);
	let version = 0;
	let cached: AssistantTool[] | null = null;

	const load = (names: Iterable<string>) => {
		let changed = false;
		for (const name of names) {
			if (loaded.has(name) || !catalog.some((tool) => tool.name === name)) continue;
			loaded.add(name);
			changed = true;
		}
		if (changed) {
			version += 1;
			cached = null;
		}
	};

	const searchTool: AssistantTool = {
		name: SEARCH_TOOL,
		title: 'Search tools',
		description:
			'Find and load Skiff tools that are not loaded yet. The system prompt lists every deferred tool by name; call this with keywords or "select:name1,name2", and the matching tools become callable on your next step. Load everything a task needs in one call where you can.',
		destructive: false,
		schema: searchSchema,
		run: async (args) => {
			const parsed = searchSchema.safeParse(args);
			if (!parsed.success)
				return { ok: false, text: `Invalid arguments for ${SEARCH_TOOL}: ${parsed.error.message}` };
			const { query, max_results } = parsed.data;
			const matches = rankTools(
				catalog.filter((tool) => tool.name !== SEARCH_TOOL),
				query,
				max_results ?? DEFAULT_RESULTS
			);
			if (matches.length === 0)
				return {
					ok: true,
					text: `No tools matched "${query}". Try other keywords, or pick a name from the deferred tool list and use "select:<name>".`
				};
			const fresh = matches.filter((tool) => !loaded.has(tool.name));
			load(matches.map((tool) => tool.name));
			const lines = matches.map(
				(tool) =>
					`- ${tool.name}${fresh.includes(tool) ? '' : ' (already loaded)'}: ${firstSentence(tool.description) || tool.title}`
			);
			return {
				ok: true,
				text: `Loaded ${matches.length} tool${matches.length === 1 ? '' : 's'}; call them on your next step:\n${lines.join('\n')}`
			};
		}
	};

	return {
		deferring,
		get version() {
			return version;
		},
		offered() {
			if (cached) return cached;
			const tools = catalog.filter((tool) => loaded.has(tool.name));
			cached = deferring ? [...tools, searchTool] : tools;
			return cached;
		},
		find(name) {
			if (deferring && name === SEARCH_TOOL) return searchTool;
			return catalog.find((tool) => tool.name === name);
		},
		isLoaded(name) {
			return (deferring && name === SEARCH_TOOL) || loaded.has(name);
		},
		load,
		prompt() {
			if (!deferring) return '';
			const deferred = catalog.filter((tool) => !loaded.has(tool.name)).map((tool) => tool.name);
			if (deferred.length === 0) return '';
			return [
				`Tool loading: only some tools are loaded. These ${deferred.length} tools also exist, but their schemas are not loaded yet:`,
				deferred.join(', '),
				`Before calling one, load it with ${SEARCH_TOOL} (keywords, or "select:name1,name2" when you know the names). Loaded tools are callable from your next step. Never tell the user a capability is missing without searching first.`
			].join('\n');
		}
	};
}
