/**
 * Browser-side: turn the renderer's `<figure data-mermaid>` placeholders into SVG diagrams.
 * Mermaid is large, so it is imported only when a page actually has a diagram, and diagrams are
 * re-rendered when the host flips `.dark` on `<html>` so they always match the theme.
 *
 * Shared by the dashboard (`/docs`) and the standalone site.
 */

type Mermaid = typeof import('mermaid').default;

let mermaidModule: Promise<Mermaid> | null = null;
let sequence = 0;

function loadMermaid(): Promise<Mermaid> {
	mermaidModule ??= import('mermaid').then((module) => module.default);
	return mermaidModule;
}

function isDark(): boolean {
	return document.documentElement.classList.contains('dark');
}

function cssVar(name: string, fallback: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return value || fallback;
}

/** Mermaid only understands hex/rgb colours, so theme tokens (oklch) are resolved via canvas. */
function toHex(color: string, fallback: string): string {
	try {
		const ctx = document.createElement('canvas').getContext('2d');
		if (!ctx) return fallback;
		ctx.fillStyle = fallback;
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
		return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
	} catch {
		return fallback;
	}
}

function themeVariables(dark: boolean) {
	const fg = toHex(cssVar('--foreground', dark ? '#fafafa' : '#171717'), dark ? '#fafafa' : '#171717');
	const bg = toHex(cssVar('--background', dark ? '#0a0a0a' : '#ffffff'), dark ? '#0a0a0a' : '#ffffff');
	const card = toHex(cssVar('--card', dark ? '#171717' : '#ffffff'), dark ? '#171717' : '#ffffff');
	const muted = toHex(cssVar('--muted', dark ? '#262626' : '#f5f5f5'), dark ? '#262626' : '#f5f5f5');
	const border = toHex(
		cssVar('--muted-foreground', dark ? '#a3a3a3' : '#737373'),
		dark ? '#a3a3a3' : '#737373'
	);
	const brand = toHex(cssVar('--brand', '#f0743a'), '#f0743a');
	return {
		darkMode: dark,
		background: bg,
		fontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
		fontSize: '14px',
		primaryColor: card,
		primaryTextColor: fg,
		primaryBorderColor: border,
		secondaryColor: muted,
		secondaryTextColor: fg,
		secondaryBorderColor: border,
		tertiaryColor: muted,
		tertiaryTextColor: fg,
		tertiaryBorderColor: border,
		lineColor: border,
		textColor: fg,
		mainBkg: card,
		nodeBorder: border,
		clusterBkg: muted,
		clusterBorder: border,
		edgeLabelBackground: bg,
		titleColor: fg,
		actorBkg: card,
		actorBorder: border,
		actorTextColor: fg,
		actorLineColor: border,
		signalColor: fg,
		signalTextColor: fg,
		labelBoxBkgColor: muted,
		labelBoxBorderColor: border,
		labelTextColor: fg,
		loopTextColor: fg,
		noteBkgColor: muted,
		noteBorderColor: brand,
		noteTextColor: fg,
		activationBkgColor: muted,
		activationBorderColor: brand,
		sequenceNumberColor: bg
	};
}

async function renderAll(figures: HTMLElement[]) {
	if (figures.length === 0) return;
	const mermaid = await loadMermaid();
	const dark = isDark();
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		theme: 'base',
		themeVariables: themeVariables(dark),
		flowchart: { curve: 'basis', padding: 12, htmlLabels: false },
		sequence: { mirrorActors: false, useMaxWidth: true }
	});
	for (const figure of figures) {
		const source = figure.dataset.source ?? '';
		if (!source) continue;
		try {
			const { svg } = await mermaid.render(`docs-diagram-${++sequence}`, source);
			figure.innerHTML = svg;
			figure.dataset.rendered = dark ? 'dark' : 'light';
			figure.removeAttribute('data-error');
		} catch {
			// Leave the source visible as a code block rather than an error graphic.
			figure.dataset.error = '';
		}
	}
}

/**
 * Render every diagram under `root` and keep them in step with the theme. Returns a cleanup
 * function for hosts that swap pages without a reload.
 */
export function enhanceDiagrams(root: ParentNode = document): () => void {
	const figures = () => [...root.querySelectorAll<HTMLElement>('figure[data-mermaid]')];
	if (figures().length === 0) return () => {};
	void renderAll(figures());
	let last = isDark();
	const observer = new MutationObserver(() => {
		const dark = isDark();
		if (dark === last) return;
		last = dark;
		void renderAll(figures());
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
	return () => observer.disconnect();
}
