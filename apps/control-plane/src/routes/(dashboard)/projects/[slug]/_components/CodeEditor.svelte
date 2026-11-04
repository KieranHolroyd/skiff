<script lang="ts">
	import { onMount } from 'svelte';
	import { mode } from 'mode-watcher';
	import Spinner from '#lib/components/ui/spinner/spinner.svelte';
	import { languageFor } from './source-utils.js';

	type Monaco = typeof import('monaco-editor');
	type Editor = import('monaco-editor').editor.IStandaloneCodeEditor;

	let {
		value,
		path,
		releaseId,
		wordWrap = false,
		minimap = true,
		oncursor,
		class: className = ''
	}: {
		value: string;
		path: string;
		releaseId: string;
		wordWrap?: boolean;
		minimap?: boolean;
		oncursor?: (position: { line: number; column: number; selected: number }) => void;
		class?: string;
	} = $props();

	let container: HTMLDivElement;
	let monaco: Monaco | null = null;
	let editor: Editor | null = null;
	let ready = $state(false);
	let failure = $state<string | null>(null);
	const models: Record<string, import('monaco-editor').editor.ITextModel> = Object.create(null);
	const viewStates: Record<string, import('monaco-editor').editor.ICodeEditorViewState> =
		Object.create(null);

	onMount(() => {
		let disposed = false;
		(async () => {
			try {
				const [EditorWorker, JsonWorker, CssWorker, HtmlWorker, TsWorker, loaded] =
					await Promise.all([
						import('monaco-editor/esm/vs/editor/editor.worker?worker'),
						import('monaco-editor/esm/vs/language/json/json.worker?worker'),
						import('monaco-editor/esm/vs/language/css/css.worker?worker'),
						import('monaco-editor/esm/vs/language/html/html.worker?worker'),
						import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
						import('monaco-editor')
					]);
				if (disposed) return;
				(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
					getWorker(_workerId: string, label: string) {
						if (label === 'json') return new JsonWorker.default();
						if (label === 'css' || label === 'scss' || label === 'less')
							return new CssWorker.default();
						if (label === 'html' || label === 'handlebars' || label === 'razor')
							return new HtmlWorker.default();
						if (label === 'typescript' || label === 'javascript') return new TsWorker.default();
						return new EditorWorker.default();
					}
				};
				monaco = loaded;
				defineThemes(monaco);
				editor = monaco.editor.create(container, {
					value,
					language: languageFor(path),
					theme: themeName(),
					readOnly: true,
					domReadOnly: true,
					automaticLayout: true,
					fontFamily: "'Geist Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 12.5,
					lineHeight: 20,
					letterSpacing: 0.1,
					fontLigatures: true,
					padding: { top: 12, bottom: 24 },
					minimap: {
						enabled: minimap,
						side: 'right',
						showSlider: 'mouseover',
						renderCharacters: false,
						scale: 0.8
					},
					scrollBeyondLastLine: false,
					smoothScrolling: true,
					cursorBlinking: 'smooth',
					cursorSmoothCaretAnimation: 'on',
					renderLineHighlight: 'all',
					renderWhitespace: 'selection',
					renderControlCharacters: false,
					stickyScroll: { enabled: true, maxLineCount: 4 },
					bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
					guides: { indentation: true, bracketPairs: true, highlightActiveIndentation: true },
					wordWrap: wordWrap ? 'on' : 'off',
					wordWrapColumn: 100,
					tabSize: 2,
					detectIndentation: true,
					folding: true,
					showFoldingControls: 'mouseover',
					lineNumbersMinChars: 3,
					glyphMargin: false,
					overviewRulerLanes: 2,
					hideCursorInOverviewRuler: true,
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10,
						useShadows: false,
						alwaysConsumeMouseWheel: false
					},
					contextmenu: false,
					links: true,
					colorDecorators: true,
					unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
					occurrencesHighlight: 'off',
					selectionHighlight: true
				} as import('monaco-editor').editor.IStandaloneEditorConstructionOptions);
				editor.onDidChangeCursorSelection((selection) => {
					const model = editor?.getModel();
					oncursor?.({
						line: selection.selection.positionLineNumber,
						column: selection.selection.positionColumn,
						selected:
							model && !selection.selection.isEmpty()
								? model.getValueInRange(selection.selection).length
								: 0
					});
				});
				ready = true;
			} catch (error) {
				failure = error instanceof Error ? error.message : 'The code editor could not start.';
			}
		})();
		return () => {
			disposed = true;
			for (const model of Object.values(models)) model.dispose();
			for (const key of Object.keys(models)) delete models[key];
			editor?.dispose();
			editor = null;
		};
	});

	$effect(() => {
		if (!ready || !monaco || !editor) return;
		const targetPath = path;
		const source = value;
		const key = `${releaseId}:${targetPath}`;
		let model = models[key];
		if (!model) {
			model = monaco.editor.createModel(
				source,
				languageFor(targetPath),
				monaco.Uri.parse(
					`skiff://release/${encodeURIComponent(releaseId)}/${encodeURIComponent(targetPath)}`
				)
			);
			models[key] = model;
		} else if (model.getValue() !== source) {
			model.setValue(source);
		}
		const previous = editor.getModel();
		if (previous && previous !== model) {
			const state = editor.saveViewState();
			if (state) viewStates[previous.uri.toString()] = state;
		}
		if (editor.getModel() !== model) {
			editor.setModel(model);
			const state = viewStates[model.uri.toString()];
			if (state) editor.restoreViewState(state);
			else {
				editor.setScrollTop(0);
				editor.setScrollLeft(0);
				editor.setPosition({ lineNumber: 1, column: 1 });
			}
		}
	});

	$effect(() => {
		const dark = mode.current === 'dark';
		if (ready && monaco) monaco.editor.setTheme(dark ? 'skiff-dark' : 'skiff-light');
	});

	$effect(() => {
		if (!ready || !editor) return;
		editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' });
	});

	$effect(() => {
		if (!ready || !editor) return;
		editor.updateOptions({ minimap: { enabled: minimap } });
	});

	function themeName(): string {
		return mode.current === 'dark' ? 'skiff-dark' : 'skiff-light';
	}

	// ---- theme palette ---------------------------------------------------------
	// The app palette is authored in OKLCH. Monaco only understands hex, so read the live CSS
	// variables and convert, keeping the editor in step with the dashboard's tokens.
	function cssVar(name: string, fallback: string): string {
		try {
			const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
			return oklchToHex(raw) ?? raw ?? fallback;
		} catch {
			return fallback;
		}
	}

	function oklchToHex(value: string): string | null {
		const match =
			/^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+)(%?))?\s*\)$/i.exec(
				value
			);
		if (!match) return null;
		const lightness = Number(match[1]) / (match[2] ? 100 : 1);
		const chroma = Number(match[3]);
		const hue = (Number(match[4]) * Math.PI) / 180;
		const alpha = match[5] ? Number(match[5]) / (match[6] ? 100 : 1) : 1;
		const a = chroma * Math.cos(hue);
		const b = chroma * Math.sin(hue);
		const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
		const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
		const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
		const channels = [
			4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
			-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
			-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
		].map((channel) => {
			const gamma = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
			return Math.max(0, Math.min(255, Math.round(gamma * 255)));
		});
		const hex = channels.map((channel) => channel.toString(16).padStart(2, '0')).join('');
		if (alpha >= 1) return `#${hex}`;
		return `#${hex}${Math.round(alpha * 255)
			.toString(16)
			.padStart(2, '0')}`;
	}

	interface Palette {
		background: string;
		foreground: string;
		muted: string;
		accent: string;
		border: string;
		popover: string;
		brand: string;
		info: string;
		success: string;
		warning: string;
		danger: string;
	}

	/**
	 * Read the dashboard tokens under a specific theme, then restore the live theme. Monaco themes
	 * are registered once for both modes, so each one has to sample its own CSS variable set.
	 */
	function readPalette(dark: boolean): Palette {
		const root = document.documentElement;
		const wasDark = root.classList.contains('dark');
		if (wasDark !== dark) root.classList.toggle('dark', dark);
		const palette: Palette = {
			background: cssVar('--card', dark ? '#1f2331' : '#ffffff'),
			foreground: cssVar('--card-foreground', dark ? '#eceef3' : '#232735'),
			muted: cssVar('--muted-foreground', dark ? '#a5a8b3' : '#6f7380'),
			accent: cssVar('--accent', dark ? '#3a3f50' : '#f2f2f6'),
			border: cssVar('--border', dark ? '#343846' : '#e5e6ec'),
			popover: cssVar('--popover', dark ? '#1f2331' : '#ffffff'),
			brand: cssVar('--brand', '#e88a4a'),
			info: cssVar('--info', '#6c8ee8'),
			success: cssVar('--success', '#4fa87a'),
			warning: cssVar('--warning', '#d7a94a'),
			danger: cssVar('--danger', '#d26060')
		};
		if (wasDark !== dark) root.classList.toggle('dark', wasDark);
		return palette;
	}

	let themesDefined = false;
	function defineThemes(monacoInstance: Monaco) {
		if (themesDefined) return;
		themesDefined = true;
		monacoInstance.editor.defineTheme(
			'skiff-dark',
			themeFrom('vs-dark', readPalette(true), [
				{ token: 'comment', foreground: '7d8598', fontStyle: 'italic' },
				{ token: 'keyword', foreground: 'e8a06b' },
				{ token: 'keyword.control', foreground: 'e8a06b' },
				{ token: 'string', foreground: '9ccf9b' },
				{ token: 'string.escape', foreground: 'd7c27a' },
				{ token: 'number', foreground: 'e5c07b' },
				{ token: 'regexp', foreground: 'd7a0d0' },
				{ token: 'type', foreground: '7dd3fc' },
				{ token: 'type.identifier', foreground: '7dd3fc' },
				{ token: 'identifier', foreground: 'd7dbe6' },
				{ token: 'function', foreground: '82aaff' },
				{ token: 'variable', foreground: 'd7dbe6' },
				{ token: 'constant', foreground: 'f29bb8' },
				{ token: 'tag', foreground: 'e8a06b' },
				{ token: 'attribute.name', foreground: '82aaff' },
				{ token: 'attribute.value', foreground: '9ccf9b' },
				{ token: 'delimiter', foreground: '9aa0ae' },
				{ token: 'metatag', foreground: 'e8a06b' },
				{ token: 'invalid', foreground: 'ff8f8f' }
			])
		);
		monacoInstance.editor.defineTheme(
			'skiff-light',
			themeFrom('vs', readPalette(false), [
				{ token: 'comment', foreground: '8b8f9a', fontStyle: 'italic' },
				{ token: 'keyword', foreground: 'b45309' },
				{ token: 'keyword.control', foreground: 'b45309' },
				{ token: 'string', foreground: '15803d' },
				{ token: 'string.escape', foreground: 'a16207' },
				{ token: 'number', foreground: 'a16207' },
				{ token: 'regexp', foreground: 'a21caf' },
				{ token: 'type', foreground: '0e7490' },
				{ token: 'type.identifier', foreground: '0e7490' },
				{ token: 'identifier', foreground: '26303c' },
				{ token: 'function', foreground: '1d4ed8' },
				{ token: 'variable', foreground: '26303c' },
				{ token: 'constant', foreground: 'be185d' },
				{ token: 'tag', foreground: 'b45309' },
				{ token: 'attribute.name', foreground: '1d4ed8' },
				{ token: 'attribute.value', foreground: '15803d' },
				{ token: 'delimiter', foreground: '6b7280' },
				{ token: 'metatag', foreground: 'b45309' },
				{ token: 'invalid', foreground: 'b91c1c' }
			])
		);
	}

	function themeFrom(
		base: 'vs' | 'vs-dark',
		palette: Palette,
		rules: import('monaco-editor').editor.ITokenThemeRule[]
	): import('monaco-editor').editor.IStandaloneThemeData {
		const {
			background,
			foreground,
			muted,
			accent,
			border,
			popover,
			brand,
			info,
			success,
			warning,
			danger
		} = palette;
		const dark = base === 'vs-dark';
		return {
			base,
			inherit: true,
			rules,
			colors: {
				'editor.background': background,
				'editor.foreground': foreground,
				'editorLineNumber.foreground': dark ? muted : `${muted}cc`,
				'editorLineNumber.activeForeground': foreground,
				'editorGutter.background': background,
				'editor.lineHighlightBackground': accent,
				'editor.lineHighlightBorder': '#00000000',
				'editor.selectionBackground': dark ? `${brand}45` : `${brand}35`,
				'editor.inactiveSelectionBackground': dark ? `${brand}22` : `${brand}1f`,
				'editor.selectionHighlightBackground': dark ? `${brand}22` : `${brand}1f`,
				'editor.wordHighlightBackground': dark ? `${info}22` : `${info}1f`,
				'editorCursor.foreground': brand,
				'editorIndentGuide.background1': border,
				'editorIndentGuide.activeBackground1': dark ? `${muted}88` : `${muted}77`,
				'editorBracketHighlight.foreground1': brand,
				'editorBracketHighlight.foreground2': info,
				'editorBracketHighlight.foreground3': success,
				'editorBracketMatch.background': dark ? `${brand}22` : `${brand}1f`,
				'editorBracketMatch.border': dark ? `${brand}66` : `${brand}55`,
				'editorWhitespace.foreground': `${muted}55`,
				'editorWidget.background': popover,
				'editorWidget.border': border,
				'editorWidget.foreground': foreground,
				'editorSuggestWidget.background': popover,
				'editorSuggestWidget.border': border,
				'editorSuggestWidget.selectedBackground': accent,
				'editorHoverWidget.background': popover,
				'editorHoverWidget.border': border,
				'editorStickyScroll.background': background,
				'editorStickyScrollHover.background': accent,
				'minimap.background': background,
				'minimap.selectionHighlight': dark ? `${brand}55` : `${brand}45`,
				'scrollbarSlider.background': `${muted}33`,
				'scrollbarSlider.hoverBackground': `${muted}55`,
				'scrollbarSlider.activeBackground': `${muted}77`,
				'editorOverviewRuler.border': '#00000000',
				'editorOverviewRuler.findMatchForeground': `${warning}aa`,
				'editorError.foreground': danger,
				'editorWarning.foreground': warning,
				'editorInfo.foreground': info
			}
		};
	}
</script>

<div class="relative size-full overflow-hidden bg-card {className}">
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
		<div class="absolute inset-0 grid place-items-center bg-card p-6 text-center">
			<div class="max-w-sm space-y-1">
				<p class="text-sm font-medium">Editor unavailable</p>
				<p class="text-xs text-muted-foreground">{failure}</p>
			</div>
		</div>
	{/if}
</div>
