import type { AssistantPageContext, AssistantPageTarget } from '@yoal/contracts';

/**
 * Turn the visible dashboard into a compact outline for the assistant. Elements with
 * `data-yoal-target` are stable anchors; headings, buttons, links, tabs and inputs are collected
 * with a CSS selector so the guide can point at almost anything without hand-editing every page.
 */

const MAX_TARGETS = 120;

function textOf(element: Element): string {
	const explicit = element.getAttribute('data-yoal-label') ?? element.getAttribute('aria-label');
	if (explicit?.trim()) return explicit.trim();
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
		return (element.placeholder || element.getAttribute('aria-label') || '').trim();
	const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
	if (text) return text;
	return (element.getAttribute('title') ?? '').trim();
}

function cssPath(element: Element): string {
	if (element.id) return `#${CSS.escape(element.id)}`;
	const parts: string[] = [];
	let node: Element | null = element;
	while (node && node !== document.body && parts.length < 5) {
		let part = node.tagName.toLowerCase();
		const parent: Element | null = node.parentElement;
		if (parent) {
			const siblings = [...parent.children].filter((child) => child.tagName === node!.tagName);
			if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
		}
		parts.unshift(part);
		node = parent;
	}
	return parts.join(' > ');
}

function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width < 2 || rect.height < 2) return false;
	const style = window.getComputedStyle(element);
	return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

function kindOf(element: Element): AssistantPageTarget['kind'] {
	if (element.tagName === 'H1' || element.tagName === 'H2' || element.tagName === 'H3')
		return 'heading';
	if (element.tagName === 'BUTTON') return 'button';
	if (element.tagName === 'A') return 'link';
	if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT')
		return 'input';
	if (element.getAttribute('role') === 'tab') return 'tab';
	if (element.getAttribute('role') === 'region' || element.tagName === 'SECTION') return 'region';
	return 'other';
}

export function collectPageContext(): AssistantPageContext {
	const path = window.location.pathname;
	const targets: AssistantPageTarget[] = [];
	const seen = new Set<Element>();

	const add = (element: Element, kind = kindOf(element)) => {
		if (seen.has(element) || targets.length >= MAX_TARGETS) return;
		if (element.closest('#yoal-assistant')) return;
		if (!visible(element)) return;
		const label = textOf(element).slice(0, 200);
		if (!label) return;
		seen.add(element);
		const id = element.getAttribute('data-yoal-target')?.trim() || undefined;
		targets.push({
			...(id ? { id } : {}),
			label,
			kind,
			selector: cssPath(element)
		});
	};

	// Stable anchors first so they are never crowded out by a long table.
	for (const element of document.querySelectorAll('[data-yoal-target]')) add(element);
	for (const element of document.querySelectorAll('h1, h2, h3, [role="tab"]')) add(element);
	for (const element of document.querySelectorAll('button, a[href]')) {
		if (element instanceof HTMLAnchorElement) {
			const href = element.getAttribute('href') ?? '';
			if (href.startsWith('#') || href.startsWith('javascript:')) continue;
		}
		add(element);
	}
	for (const element of document.querySelectorAll('input, textarea, select')) add(element);

	const project = /^\/projects\/([^/]+)/.exec(path)?.[1];
	return {
		path,
		title: document.title,
		...(project ? { project: decodeURIComponent(project) } : {}),
		targets: targets.slice(0, MAX_TARGETS)
	};
}

/** Resolve a tour step to a live element (target id first, then an authenticated selector). */
export function resolveTourTarget(target?: string, selector?: string): Element | null {
	if (target) {
		const found = document.querySelector(`[data-yoal-target="${CSS.escape(target)}"]`);
		if (found) return found;
	}
	if (selector) {
		try {
			return document.querySelector(selector);
		} catch {
			return null;
		}
	}
	return null;
}

/** Wait for client-side navigation and deferred rendering to settle. */
export function waitForElement(
	resolve: () => Element | null,
	timeoutMs = 3_000
): Promise<Element | null> {
	return new Promise((done) => {
		const found = resolve();
		if (found) return done(found);
		const started = Date.now();
		let frame = 0;
		const tick = () => {
			const element = resolve();
			if (element) return done(element);
			if (Date.now() - started > timeoutMs) return done(null);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	});
}
