<script module lang="ts">
	let modelCounter = 0;
	const MARKER_OWNER = 'yoal-studio';
</script>

<script lang="ts">
	import { mode } from 'mode-watcher';
	import Spinner from '#lib/components/ui/spinner/spinner.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { StudioEditorProps } from '../ui-types.js';
	import {
		bindCompletion,
		loadMonaco,
		monacoLanguage,
		MONGO_MODEL_SUFFIX,
		type Monaco
	} from './monaco.js';
	import { utf16Offset, type RunTarget } from './positions.js';
	import { THEME_DARK, THEME_LIGHT } from './theme.js';

	type Editor = import('monaco-editor').editor.IStandaloneCodeEditor;
	type Model = import('monaco-editor').editor.ITextModel;

	let {
		value = $bindable(''),
		language,
		dialect,
		completion,
		onrun,
		markers = [],
		readOnly = false,
		class: className = ''
	}: StudioEditorProps = $props();

	let container: HTMLDivElement;
	let monaco: Monaco | null = null;
	let editor: Editor | null = null;
	let model: Model | null = null;
	let ready = $state(false);
	let failure = $state<string | null>(null);
	/** Bumped by "Try again" to re-run the mount effect. */
	let attempt = $state(0);

	/** The selection when it has text, else the whole input, and where it starts. */
	export function runTarget(): RunTarget {
		if (!editor || !model) return { text: value ?? '', offset: 0 };
		const selection = editor.getSelection();
		if (selection && !selection.isEmpty()) {
			const text = model.getValueInRange(selection);
			if (text.trim()) return { text, offset: model.getOffsetAt(selection.getStartPosition()) };
		}
		return { text: model.getValue(), offset: 0 };
	}

	export function focus(): void {
		editor?.focus();
	}

	function run() {
		const target = runTarget();
		if (target.text.trim()) onrun?.(target.text);
	}

	$effect(() => {
		void attempt;
		let disposed = false;
		const disposables: Array<{ dispose(): void }> = [];
		failure = null;
		(async () => {
			try {
				const loaded = await loadMonaco();
				if (disposed) return;
				monaco = loaded;
				const suffix = language === 'mongo' ? MONGO_MODEL_SUFFIX : '.txt';
				model = loaded.editor.createModel(
					value ?? '',
					monacoLanguage(language, dialect),
					loaded.Uri.parse(`inmemory://yoal-studio/query-${++modelCounter}${suffix}`)
				);
				editor = loaded.editor.create(container, {
					model,
					theme: mode.current === 'dark' ? THEME_DARK : THEME_LIGHT,
					readOnly,
					automaticLayout: true,
					ariaLabel: 'Query editor',
					fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 12.5,
					lineHeight: 20,
					letterSpacing: 0.1,
					fontLigatures: true,
					padding: { top: 8, bottom: 8 },
					minimap: { enabled: false },
					wordWrap: 'on',
					scrollBeyondLastLine: false,
					smoothScrolling: true,
					cursorBlinking: 'smooth',
					renderLineHighlight: 'line',
					tabSize: 2,
					lineNumbersMinChars: 3,
					glyphMargin: false,
					folding: false,
					overviewRulerLanes: 2,
					hideCursorInOverviewRuler: true,
					// Suggest and hover widgets escape the pane's overflow clipping.
					fixedOverflowWidgets: true,
					quickSuggestions: { other: true, comments: false, strings: true },
					suggestOnTriggerCharacters: true,
					bracketPairColorization: { enabled: true },
					unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10,
						useShadows: false,
						alwaysConsumeMouseWheel: false
					},
					contextmenu: true
				});
				disposables.push(
					editor.addAction({
						id: 'yoal.studio.run',
						label: 'Run',
						keybindings: [loaded.KeyMod.CtrlCmd | loaded.KeyCode.Enter],
						contextMenuGroupId: 'navigation',
						contextMenuOrder: 0,
						run: () => run()
					}),
					model.onDidChangeContent(() => {
						if (!model) return;
						// Markers point at the text they were reported for; any edit retires them.
						loaded.editor.setModelMarkers(model, MARKER_OWNER, []);
						value = model.getValue();
					})
				);
				ready = true;
			} catch (error) {
				if (!disposed)
					failure = error instanceof Error ? error.message : 'The query editor could not start.';
			}
		})();
		return () => {
			disposed = true;
			ready = false;
			for (const disposable of disposables) disposable.dispose();
			editor?.dispose();
			model?.dispose();
			editor = null;
			model = null;
		};
	});

	// Outside changes to `value` (history, "Query this table") replace the text as one undoable edit.
	$effect(() => {
		const next = value ?? '';
		if (!ready || !model || model.getValue() === next) return;
		model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null);
	});

	$effect(() => {
		const id = monacoLanguage(language, dialect);
		if (ready && monaco && model && model.getLanguageId() !== id)
			monaco.editor.setModelLanguage(model, id);
	});

	$effect(() => {
		if (!ready || !model || !completion) return;
		return bindCompletion(model, completion);
	});

	$effect(() => {
		const locked = readOnly;
		if (ready && editor) editor.updateOptions({ readOnly: locked });
	});

	$effect(() => {
		const dark = mode.current === 'dark';
		if (ready && monaco) monaco.editor.setTheme(dark ? THEME_DARK : THEME_LIGHT);
	});

	$effect(() => {
		const list = markers;
		if (!ready || !monaco || !model) return;
		const current = model;
		const text = current.getValue();
		monaco.editor.setModelMarkers(
			current,
			MARKER_OWNER,
			list.map((marker) => {
				const start = current.getPositionAt(utf16Offset(text, marker.position));
				const word = current.getWordAtPosition(start);
				return {
					severity: monaco!.MarkerSeverity.Error,
					message: marker.message,
					startLineNumber: start.lineNumber,
					endLineNumber: start.lineNumber,
					startColumn: word?.startColumn ?? start.column,
					endColumn: word?.endColumn ?? start.column + 1
				};
			})
		);
	});
</script>

<div class="relative size-full min-h-0 overflow-hidden bg-card {className}">
	<div bind:this={container} class="absolute inset-0"></div>
	{#if !ready && !failure}
		<div
			class="pointer-events-none absolute inset-0 grid place-items-center bg-card text-muted-foreground"
		>
			<span class="flex items-center gap-2 font-mono text-xs">
				<Spinner class="size-3.5" />
				Starting editor
			</span>
		</div>
	{/if}
	{#if failure}
		<div class="absolute inset-0 grid place-items-center bg-card p-6 text-center" role="alert">
			<div class="max-w-sm space-y-2">
				<p class="text-sm font-medium">Editor unavailable</p>
				<p class="text-xs text-muted-foreground">{failure}</p>
				<Button variant="outline" size="sm" onclick={() => attempt++}>Try again</Button>
			</div>
		</div>
	{/if}
</div>
