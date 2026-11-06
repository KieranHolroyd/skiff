import type { editor } from 'monaco-editor';

/**
 * The dashboard's Monaco themes (same names and palette as the project code view), so every
 * editor in the dashboard looks the same. Monaco only understands hex, so the OKLCH CSS tokens
 * are read live and converted.
 */
export const THEME_DARK = 'skiff-dark';
export const THEME_LIGHT = 'skiff-light';

type MonacoEditorApi = typeof editor;

function cssVar(name: string, fallback: string): string {
	try {
		const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return oklchToHex(raw) ?? (raw || fallback);
	} catch {
		return fallback;
	}
}

export function oklchToHex(value: string): string | null {
	const match =
		/^oklch\(\s*([0-9.]+)(%?)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+)(%?))?\s*\)$/i.exec(value);
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

/** Sample the tokens under one theme, then restore the live one. */
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

const DARK_RULES: editor.ITokenThemeRule[] = [
	{ token: 'comment', foreground: '7d8598', fontStyle: 'italic' },
	{ token: 'keyword', foreground: 'e8a06b' },
	{ token: 'operator', foreground: 'e8a06b' },
	{ token: 'predefined', foreground: '82aaff' },
	{ token: 'string', foreground: '9ccf9b' },
	{ token: 'string.escape', foreground: 'd7c27a' },
	{ token: 'string.key.json', foreground: '82aaff' },
	{ token: 'string.value.json', foreground: '9ccf9b' },
	{ token: 'number', foreground: 'e5c07b' },
	{ token: 'type', foreground: '7dd3fc' },
	{ token: 'identifier', foreground: 'd7dbe6' },
	{ token: 'identifier.quote', foreground: 'd7dbe6' },
	{ token: 'delimiter', foreground: '9aa0ae' },
	{ token: 'invalid', foreground: 'ff8f8f' }
];

const LIGHT_RULES: editor.ITokenThemeRule[] = [
	{ token: 'comment', foreground: '8b8f9a', fontStyle: 'italic' },
	{ token: 'keyword', foreground: 'b45309' },
	{ token: 'operator', foreground: 'b45309' },
	{ token: 'predefined', foreground: '1d4ed8' },
	{ token: 'string', foreground: '15803d' },
	{ token: 'string.escape', foreground: 'a16207' },
	{ token: 'string.key.json', foreground: '1d4ed8' },
	{ token: 'string.value.json', foreground: '15803d' },
	{ token: 'number', foreground: 'a16207' },
	{ token: 'type', foreground: '0e7490' },
	{ token: 'identifier', foreground: '26303c' },
	{ token: 'identifier.quote', foreground: '26303c' },
	{ token: 'delimiter', foreground: '6b7280' },
	{ token: 'invalid', foreground: 'b91c1c' }
];

function themeFrom(
	base: 'vs' | 'vs-dark',
	palette: Palette,
	rules: editor.ITokenThemeRule[]
): editor.IStandaloneThemeData {
	const { background, foreground, muted, accent, border, popover, brand, info, success, warning, danger } =
		palette;
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
			'editorBracketHighlight.foreground1': brand,
			'editorBracketHighlight.foreground2': info,
			'editorBracketHighlight.foreground3': success,
			'editorBracketMatch.background': dark ? `${brand}22` : `${brand}1f`,
			'editorBracketMatch.border': dark ? `${brand}66` : `${brand}55`,
			'editorWidget.background': popover,
			'editorWidget.border': border,
			'editorWidget.foreground': foreground,
			'editorSuggestWidget.background': popover,
			'editorSuggestWidget.border': border,
			'editorSuggestWidget.selectedBackground': accent,
			'editorHoverWidget.background': popover,
			'editorHoverWidget.border': border,
			'menu.background': popover,
			'menu.border': border,
			'scrollbarSlider.background': `${muted}33`,
			'scrollbarSlider.hoverBackground': `${muted}55`,
			'scrollbarSlider.activeBackground': `${muted}77`,
			'editorOverviewRuler.border': '#00000000',
			'editorError.foreground': danger,
			'editorWarning.foreground': warning,
			'editorInfo.foreground': info
		}
	};
}

let defined = false;

export function defineThemes(api: MonacoEditorApi): void {
	if (defined) return;
	defined = true;
	api.defineTheme(THEME_DARK, themeFrom('vs-dark', readPalette(true), DARK_RULES));
	api.defineTheme(THEME_LIGHT, themeFrom('vs', readPalette(false), LIGHT_RULES));
}
