import type * as MonacoApi from 'monaco-editor';
import type { StudioInfo } from '@skiff/studio/protocol';
import { completionContext, resolveAlias } from '../completion.js';
import type { CompletionItem, CompletionSource } from '../ui-types.js';
import { defineThemes } from './theme.js';

/**
 * One Monaco instance for the page (plan 22). It is only ever dynamically imported, so it stays
 * out of the dashboard's main bundle; the first studio editor pays for it and later editors
 * reuse it. Languages and completion providers are registered once here; each editor binds its
 * model to its own `CompletionSource`.
 */
export type Monaco = typeof MonacoApi;

export const REDIS_LANGUAGE = 'skiff-redis';
/** Mongo command models end in this, so the command JSON schema applies to them only. */
export const MONGO_MODEL_SUFFIX = '.skiff-mongo.json';

export function monacoLanguage(
	language: StudioInfo['capabilities']['language'],
	dialect?: StudioInfo['capabilities']['dialect']
): string {
	if (language === 'mongo') return 'json';
	if (language === 'redis') return REDIS_LANGUAGE;
	return dialect === 'mysql' || dialect === 'mariadb' ? 'mysql' : 'pgsql';
}

/** Completion sources by model URI. */
const sources = new Map<string, CompletionSource>();

export function bindCompletion(model: MonacoApi.editor.ITextModel, source: CompletionSource): () => void {
	const key = model.uri.toString();
	sources.set(key, source);
	return () => {
		if (sources.get(key) === source) sources.delete(key);
	};
}

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
	loading ??= load().catch((error) => {
		loading = null;
		throw error;
	});
	return loading;
}

async function load(): Promise<Monaco> {
	const [EditorWorker, JsonWorker, monaco] = await Promise.all([
		import('monaco-editor/esm/vs/editor/editor.worker?worker'),
		import('monaco-editor/esm/vs/language/json/json.worker?worker'),
		import('monaco-editor')
	]);
	const scope = self as unknown as { MonacoEnvironment?: MonacoApi.Environment };
	// The project code view may have set a richer environment (CSS/HTML/TS workers) already; it
	// covers ours, so keep it. Otherwise only the editor and JSON workers are needed.
	scope.MonacoEnvironment ??= {
		getWorker(_workerId: string, label: string) {
			return label === 'json' ? new JsonWorker.default() : new EditorWorker.default();
		}
	};
	defineThemes(monaco.editor);
	registerRedis(monaco);
	registerMongoSchema(monaco);
	for (const language of ['pgsql', 'mysql', 'json', REDIS_LANGUAGE]) registerCompletion(monaco, language);
	return monaco;
}

// ---------------------------------------------------------------- completion

const KIND_RANK: Record<CompletionItem['kind'], string> = {
	column: '0',
	field: '0',
	key: '0',
	table: '1',
	view: '1',
	collection: '1',
	schema: '2',
	command: '3',
	snippet: '3',
	keyword: '4'
};

function monacoKind(monaco: Monaco, kind: CompletionItem['kind']): MonacoApi.languages.CompletionItemKind {
	const kinds = monaco.languages.CompletionItemKind;
	switch (kind) {
		case 'schema':
			return kinds.Module;
		case 'table':
		case 'collection':
			return kinds.Struct;
		case 'view':
			return kinds.Interface;
		case 'column':
		case 'field':
			return kinds.Field;
		case 'key':
			return kinds.Variable;
		case 'keyword':
			return kinds.Keyword;
		case 'command':
			return kinds.Function;
		case 'snippet':
			return kinds.Snippet;
	}
}

/**
 * Where the cursor is in a JSON line: inside a string used as a value (`"find": "or`), inside a
 * key string, or outside any string.
 */
export function jsonCursor(lineBefore: string): 'value' | 'key' | 'outside' {
	let open = -1;
	for (let index = 0; index < lineBefore.length; index++) {
		const char = lineBefore[index];
		if (char === '\\' && open >= 0) index++;
		else if (char === '"') open = open >= 0 ? -1 : index;
	}
	if (open < 0) return 'outside';
	return /:\s*$/.test(lineBefore.slice(0, open)) ? 'value' : 'key';
}

function registerCompletion(monaco: Monaco, language: string): void {
	const sql = language === 'pgsql' || language === 'mysql';
	monaco.languages.registerCompletionItemProvider(language, {
		triggerCharacters: sql ? ['.'] : language === 'json' ? ['"'] : [],
		async provideCompletionItems(model, position) {
			const source = sources.get(model.uri.toString());
			if (!source) return { suggestions: [] };
			const lineBefore = model.getValueInRange({
				startLineNumber: position.lineNumber,
				startColumn: 1,
				endLineNumber: position.lineNumber,
				endColumn: position.column
			});
			const word = model.getWordUntilPosition(position);
			const range = {
				startLineNumber: position.lineNumber,
				endLineNumber: position.lineNumber,
				startColumn: word.startColumn,
				endColumn: word.endColumn
			};
			const context = completionContext(lineBefore);
			if (!sql) delete context.qualifier;
			if (sql && context.qualifier) context.qualifier = resolveAlias(model.getValue(), context.qualifier);
			if (language === REDIS_LANGUAGE && /\S\s/.test(lineBefore.trimStart())) {
				// Only the command position completes; arguments are free-form.
				return { suggestions: [] };
			}
			let items: CompletionItem[];
			try {
				items = await source.items(context);
			} catch {
				return { suggestions: [] };
			}
			if (language === 'json') {
				// A string value: collection names. An empty document: whole command snippets. Keys
				// come from the command JSON schema through the JSON worker.
				const where = jsonCursor(lineBefore.slice(0, word.startColumn - 1));
				const empty = /^\s*\{?\s*\}?\s*$/.test(model.getValue());
				items = items.filter((item) =>
					item.kind === 'snippet' || item.kind === 'command'
						? where === 'outside' && empty
						: where === 'value'
				);
			}
			return {
				// SQL sources cap each level by prefix, so ask again as the word grows.
				incomplete: sql,
				suggestions: items.map((item, index) => ({
					label: item.label,
					kind: monacoKind(monaco, item.kind),
					detail: item.detail,
					insertText: item.insertText ?? item.label,
					insertTextRules:
						item.kind === 'snippet'
							? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
							: undefined,
					sortText: `${KIND_RANK[item.kind]}${String(index).padStart(4, '0')}`,
					range:
						item.kind === 'snippet' && language === 'json'
							? model.getFullModelRange()
							: range
				}))
			};
		}
	});
}

// ---------------------------------------------------------------- Redis / Valkey

function registerRedis(monaco: Monaco): void {
	if (monaco.languages.getLanguages().some((entry) => entry.id === REDIS_LANGUAGE)) return;
	monaco.languages.register({ id: REDIS_LANGUAGE, aliases: ['Redis command'] });
	monaco.languages.setLanguageConfiguration(REDIS_LANGUAGE, {
		comments: { lineComment: '#' },
		autoClosingPairs: [
			{ open: '"', close: '"' },
			{ open: "'", close: "'" }
		],
		surroundingPairs: [
			{ open: '"', close: '"' },
			{ open: "'", close: "'" }
		]
	});
	monaco.languages.setMonarchTokensProvider(REDIS_LANGUAGE, {
		ignoreCase: true,
		defaultToken: '',
		tokenizer: {
			root: [
				[/^\s*#.*$/, 'comment'],
				// The first word on the line is the command.
				[/^(\s*)([A-Za-z][\w.|-]*)/, ['white', 'keyword']],
				[/"/, 'string', '@dstring'],
				[/'/, 'string', '@sstring'],
				[/-?\d+(\.\d+)?(?=\s|$)/, 'number'],
				[/[^\s"']+/, 'identifier'],
				[/\s+/, 'white']
			],
			dstring: [
				[/[^\\"]+/, 'string'],
				[/\\(x[0-9a-fA-F]{2}|.)/, 'string.escape'],
				[/"/, 'string', '@pop']
			],
			sstring: [
				[/[^\\']+/, 'string'],
				[/\\'/, 'string.escape'],
				[/\\/, 'string'],
				[/'/, 'string', '@pop']
			]
		}
	});
}

// ---------------------------------------------------------------- MongoDB

const collection = { type: 'string', description: 'Collection name' };
const document = { type: 'object' };

/** Top-level command names (and their usual options), so the JSON worker suggests them. */
export const MONGO_COMMAND_SCHEMA = {
	type: 'object',
	description: 'One MongoDB command document (EJSON). The first key is the command.',
	properties: {
		find: { ...collection, description: 'find: query a collection' },
		filter: { ...document, description: 'Query filter' },
		projection: { ...document, description: 'Fields to include or exclude' },
		sort: { ...document, description: 'Sort order, e.g. {"createdAt": -1}' },
		limit: { type: 'integer', description: 'Maximum documents' },
		skip: { type: 'integer', description: 'Documents to skip' },
		aggregate: { ...collection, description: 'aggregate: run a pipeline on a collection' },
		pipeline: { type: 'array', description: 'Aggregation stages' },
		cursor: { ...document, description: 'Cursor options, usually {}' },
		count: { ...collection, description: 'count: count documents' },
		countDocuments: { ...collection, description: 'countDocuments: count matching documents' },
		query: { ...document, description: 'Query filter' },
		distinct: { ...collection, description: 'distinct: distinct values of a field' },
		key: { type: 'string', description: 'Field for distinct' },
		insert: { ...collection, description: 'insert: add documents (write session)' },
		documents: { type: 'array', description: 'Documents to insert' },
		update: { ...collection, description: 'update: change documents (write session)' },
		updates: { type: 'array', description: 'Update statements: {"q": …, "u": …}' },
		delete: { ...collection, description: 'delete: remove documents (write session)' },
		deletes: { type: 'array', description: 'Delete statements: {"q": …, "limit": 0|1}' },
		listCollections: { type: 'integer', description: 'listCollections: list collections' },
		nameOnly: { type: 'boolean' },
		listIndexes: { ...collection, description: "listIndexes: a collection's indexes" },
		collStats: { ...collection, description: 'collStats: collection statistics' },
		dbStats: { type: 'integer', description: 'dbStats: database statistics' },
		explain: { ...document, description: 'explain: plan a find/aggregate/count/distinct' },
		verbosity: { enum: ['queryPlanner', 'executionStats', 'allPlansExecution'] },
		ping: { type: 'integer' },
		buildInfo: { type: 'integer' },
		serverStatus: { type: 'integer' },
		hello: { type: 'integer' }
	}
};

function registerMongoSchema(monaco: Monaco): void {
	const defaults = monaco.json.jsonDefaults;
	const schemas = (defaults.diagnosticsOptions.schemas ?? []).filter(
		(schema) => schema.uri !== 'skiff://studio/mongo-command.json'
	);
	defaults.setDiagnosticsOptions({
		...defaults.diagnosticsOptions,
		validate: true,
		allowComments: false,
		schemas: [
			...schemas,
			{
				uri: 'skiff://studio/mongo-command.json',
				fileMatch: [`*${MONGO_MODEL_SUFFIX}`],
				schema: MONGO_COMMAND_SCHEMA
			}
		]
	});
}
