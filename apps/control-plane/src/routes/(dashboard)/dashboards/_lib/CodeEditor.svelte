<script module lang="ts">
	import type * as MonacoApi from 'monaco-editor';
	import { sqlMacros, type ObservabilitySchema } from '@yoal/contracts';
	import type { Monaco } from '#lib/studio/editor/monaco.js';

	/**
	 * Completion context per editor model: the telemetry schema and the dashboard's variables.
	 * One provider serves every observability SQL editor on the page.
	 */
	interface SqlSource {
		schema: ObservabilitySchema | undefined;
		variables: string[];
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a plain registry read by Monaco, not UI state
	const sources = new Map<string, SqlSource>();
	let registered = false;
	let counter = 0;

	const MACRO_DOCS: Record<string, { insert: string; doc: string }> = {
		$__timeFilter: {
			insert: '\\$__timeFilter(${1:bucket})',
			doc: 'col >= from AND col < to, for the dashboard range'
		},
		$__timeInterval: {
			insert: '\\$__timeInterval(${1:bucket})',
			doc: 'Rounds col down to the panel interval (use as the time column)'
		},
		$__fromTime: { insert: '\\$__fromTime', doc: 'Range start as a DateTime' },
		$__toTime: { insert: '\\$__toTime', doc: 'Range end as a DateTime' },
		$__interval_s: { insert: '\\$__interval_s', doc: 'Panel interval in seconds' }
	};

	const FUNCTIONS = [
		'sum',
		'avg',
		'min',
		'max',
		'count',
		'countIf',
		'sumIf',
		'avgIf',
		'uniq',
		'uniqExact',
		'any',
		'anyLast',
		'argMax',
		'argMin',
		'quantile',
		'quantiles',
		'round',
		'if',
		'multiIf',
		'coalesce',
		'nullIf',
		'toStartOfMinute',
		'toStartOfFiveMinutes',
		'toStartOfHour',
		'toStartOfDay',
		'toStartOfInterval',
		'toDateTime',
		'toDate',
		'now',
		'dateDiff',
		'toUnixTimestamp',
		'formatReadableSize',
		'greatest',
		'least',
		'lower',
		'upper',
		'concat',
		'like',
		'ilike',
		'splitByChar',
		'arrayJoin',
		'groupArray',
		'topK'
	];
	const KEYWORDS = [
		'SELECT',
		'FROM',
		'WHERE',
		'GROUP BY',
		'ORDER BY',
		'LIMIT',
		'HAVING',
		'AS',
		'AND',
		'OR',
		'NOT',
		'IN',
		'BETWEEN',
		'WITH',
		'JOIN',
		'LEFT JOIN',
		'ON',
		'USING',
		'DESC',
		'ASC',
		'DISTINCT',
		'CASE',
		'WHEN',
		'THEN',
		'ELSE',
		'END',
		'INTERVAL',
		'FINAL',
		'SETTINGS',
		'UNION ALL'
	];

	function register(monaco: Monaco) {
		if (registered) return;
		registered = true;
		monaco.languages.registerCompletionItemProvider('sql', {
			triggerCharacters: ['$', '.'],
			provideCompletionItems(model, position) {
				const source = sources.get(model.uri.toString());
				if (!source) return { suggestions: [] };
				const kinds = monaco.languages.CompletionItemKind;
				const word = model.getWordUntilPosition(position);
				const before = model.getValueInRange({
					startLineNumber: position.lineNumber,
					startColumn: 1,
					endLineNumber: position.lineNumber,
					endColumn: position.column
				});
				const dollar = /\$\{?[a-z_]*$/i.exec(before);
				const range = {
					startLineNumber: position.lineNumber,
					endLineNumber: position.lineNumber,
					startColumn: dollar ? position.column - dollar[0].length : word.startColumn,
					endColumn: word.endColumn
				};
				const suggestions: MonacoApi.languages.CompletionItem[] = [];
				const snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
				for (const macro of sqlMacros) {
					const doc = MACRO_DOCS[macro];
					suggestions.push({
						label: macro,
						kind: kinds.Function,
						detail: 'macro',
						documentation: doc?.doc,
						insertText: doc?.insert ?? macro.replace('$', '\\$'),
						insertTextRules: snippet,
						sortText: '0',
						range
					});
				}
				for (const name of source.variables) {
					suggestions.push({
						label: `$${name}`,
						kind: kinds.Variable,
						detail: 'dashboard variable',
						insertText: `\\$${name}`,
						insertTextRules: snippet,
						sortText: '1',
						range
					});
				}
				if (dollar) return { suggestions };
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway dedupe set
				const seen = new Set<string>();
				for (const table of source.schema?.tables ?? []) {
					suggestions.push({
						label: table.name,
						kind: kinds.Struct,
						detail: `${table.engine} · ${table.rows.toLocaleString('en-GB')} rows`,
						insertText: table.name,
						sortText: '2',
						range
					});
					for (const column of table.columns) {
						if (seen.has(column.name)) continue;
						seen.add(column.name);
						suggestions.push({
							label: column.name,
							kind: kinds.Field,
							detail: column.type,
							documentation: column.comment || undefined,
							insertText: column.name,
							sortText: '3',
							range
						});
					}
				}
				for (const fn of FUNCTIONS) {
					suggestions.push({
						label: fn,
						kind: kinds.Function,
						insertText: `${fn}($0)`,
						insertTextRules: snippet,
						sortText: '4',
						range
					});
				}
				for (const keyword of KEYWORDS) {
					suggestions.push({
						label: keyword,
						kind: kinds.Keyword,
						insertText: keyword,
						sortText: '5',
						range
					});
				}
				return { suggestions };
			}
		});
	}
</script>

<script lang="ts">
	/**
	 * Monaco for observability SQL (ClickHouse) and dashboard JSON. Shares the studio's lazily
	 * loaded Monaco instance and themes. Ctrl/Cmd+Enter runs.
	 */
	import { mode } from 'mode-watcher';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { loadMonaco } from '#lib/studio/editor/monaco.js';
	import { THEME_DARK, THEME_LIGHT } from '#lib/studio/editor/theme.js';

	let {
		value = $bindable(''),
		language = 'sql',
		schema,
		variables = [],
		onrun,
		readOnly = false,
		label = 'SQL editor',
		class: className = ''
	}: {
		value?: string;
		language?: 'sql' | 'json';
		schema?: ObservabilitySchema;
		variables?: string[];
		onrun?: (text: string) => void;
		readOnly?: boolean;
		label?: string;
		class?: string;
	} = $props();

	let container: HTMLDivElement;
	let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
	let model: MonacoApi.editor.ITextModel | null = null;
	let monacoRef: Monaco | null = null;
	let ready = $state(false);
	let failure = $state<string | null>(null);
	let attempt = $state(0);

	export function focus() {
		editor?.focus();
	}

	$effect(() => {
		void attempt;
		let disposed = false;
		failure = null;
		(async () => {
			try {
				const monaco = await loadMonaco();
				if (disposed) return;
				monacoRef = monaco;
				register(monaco);
				model = monaco.editor.createModel(
					value ?? '',
					language,
					monaco.Uri.parse(`inmemory://yoal-observability/query-${++counter}.${language}`)
				);
				editor = monaco.editor.create(container, {
					model,
					theme: mode.current === 'dark' ? THEME_DARK : THEME_LIGHT,
					readOnly,
					automaticLayout: true,
					ariaLabel: label,
					fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 12.5,
					lineHeight: 20,
					padding: { top: 8, bottom: 8 },
					minimap: { enabled: false },
					wordWrap: 'on',
					scrollBeyondLastLine: false,
					tabSize: 2,
					lineNumbersMinChars: 3,
					glyphMargin: false,
					folding: language === 'json',
					overviewRulerLanes: 0,
					fixedOverflowWidgets: true,
					quickSuggestions: { other: true, comments: false, strings: false },
					suggestOnTriggerCharacters: true,
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10,
						useShadows: false,
						alwaysConsumeMouseWheel: false
					},
					unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false }
				});
				editor.addAction({
					id: 'yoal.observability.run',
					label: 'Run query',
					keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
					run: () => onrun?.(model?.getValue() ?? '')
				});
				model.onDidChangeContent(() => {
					if (model) value = model.getValue();
				});
				ready = true;
			} catch (error) {
				if (!disposed)
					failure = error instanceof Error ? error.message : 'The editor could not start.';
			}
		})();
		return () => {
			disposed = true;
			ready = false;
			if (model) sources.delete(model.uri.toString());
			editor?.dispose();
			model?.dispose();
			editor = null;
			model = null;
		};
	});

	$effect(() => {
		const next = value ?? '';
		if (!ready || !model || model.getValue() === next) return;
		model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
	});

	$effect(() => {
		const source = { schema, variables };
		if (ready && model) sources.set(model.uri.toString(), source);
	});

	$effect(() => {
		const dark = mode.current === 'dark';
		if (ready && monacoRef) monacoRef.editor.setTheme(dark ? THEME_DARK : THEME_LIGHT);
	});

	$effect(() => {
		const locked = readOnly;
		if (ready && editor) editor.updateOptions({ readOnly: locked });
	});

	/** Insert text at the cursor (schema browser clicks). */
	export function insert(text: string) {
		if (!editor || !model) {
			value = `${value}${text}`;
			return;
		}
		const selection = editor.getSelection();
		if (!selection) return;
		editor.executeEdits('yoal.insert', [{ range: selection, text, forceMoveMarkers: true }]);
		editor.focus();
	}
</script>

<div class="relative min-h-0 overflow-hidden rounded-lg border bg-card {className}">
	<div bind:this={container} class="absolute inset-0"></div>
	{#if !ready && !failure}
		<div class="pointer-events-none absolute inset-0 grid place-items-center text-muted-foreground">
			<span class="flex items-center gap-2 font-mono text-xs"
				><Spinner class="size-3.5" />Starting editor</span
			>
		</div>
	{/if}
	{#if failure}
		<div class="absolute inset-0 grid place-items-center p-4 text-center" role="alert">
			<div class="space-y-2">
				<p class="text-xs text-muted-foreground">{failure}</p>
				<Button variant="outline" size="sm" onclick={() => attempt++}>Try again</Button>
			</div>
		</div>
	{/if}
</div>
