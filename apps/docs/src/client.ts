import type { SearchEntry } from '@yoal/docs';
import { enhanceDiagrams } from '@yoal/docs/diagrams';
import { searchDocs, type SearchHit } from '@yoal/docs/search';

/**
 * Progressive enhancement for the static docs: everything works without it except search.
 * Bundled by build.ts into one small module.
 */

const base = document.body.dataset.base ?? '/';

// Theme -------------------------------------------------------------------------------------
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
	const dark = !document.documentElement.classList.contains('dark');
	document.documentElement.classList.toggle('dark', dark);
	try {
		localStorage.setItem('yoal-docs-theme', dark ? 'dark' : 'light');
	} catch {
		// Private mode: the choice lasts for this page only.
	}
});

// Mobile navigation -------------------------------------------------------------------------
const toggle = document.querySelector<HTMLButtonElement>('[data-nav-toggle]');
const scrim = document.querySelector<HTMLElement>('[data-nav-scrim]');
function setNav(open: boolean) {
	document.body.toggleAttribute('data-nav-open', open);
	toggle?.setAttribute('aria-expanded', String(open));
	toggle?.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
	if (scrim) scrim.hidden = !open;
}
toggle?.addEventListener('click', () => setNav(!document.body.hasAttribute('data-nav-open')));
scrim?.addEventListener('click', () => setNav(false));
document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && document.body.hasAttribute('data-nav-open')) setNav(false);
});
document
	.querySelector('[aria-current="page"]')
	?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

// Diagrams (Mermaid is loaded as a separate chunk, only on pages that have one) ------------
const prose = document.querySelector<HTMLElement>('[data-prose]');
if (prose) enhanceDiagrams(prose);

// Copy buttons ------------------------------------------------------------------------------
document.querySelector('[data-prose]')?.addEventListener('click', async (event) => {
	const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-docs-copy]');
	if (!button) return;
	const code = button.parentElement?.querySelector('pre')?.innerText ?? '';
	try {
		await navigator.clipboard.writeText(code.replace(/\n$/, ''));
		button.textContent = 'Copied';
		button.dataset.copied = '';
	} catch {
		button.textContent = 'Copy failed';
	}
	setTimeout(() => {
		button.textContent = 'Copy';
		delete button.dataset.copied;
	}, 1500);
});

// On this page ------------------------------------------------------------------------------
const tocLinks = new Map(
	[...document.querySelectorAll<HTMLAnchorElement>('[data-toc-link]')].map((link) => [
		link.dataset.tocLink!,
		link
	])
);
if (tocLinks.size > 0 && 'IntersectionObserver' in window) {
	let active: HTMLAnchorElement | null = null;
	const activate = (id: string) => {
		const link = tocLinks.get(id);
		if (!link || link === active) return;
		active?.removeAttribute('data-active');
		link.setAttribute('data-active', '');
		active = link;
	};
	activate([...tocLinks.keys()][0]!);
	const observer = new IntersectionObserver(
		(records) => {
			const visible = records
				.filter((record) => record.isIntersecting)
				.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
			if (visible[0]) activate(visible[0].target.id);
		},
		{ rootMargin: '-64px 0px -70% 0px' }
	);
	for (const id of tocLinks.keys()) {
		const heading = document.getElementById(id);
		if (heading) observer.observe(heading);
	}
}

// Search ------------------------------------------------------------------------------------
const input = document.querySelector<HTMLInputElement>('[data-search-input]');
const results = document.querySelector<HTMLElement>('[data-search-results]');
let index: SearchEntry[] | null = null;
let loading: Promise<void> | null = null;
let hits: SearchHit[] = [];
let selected = 0;

function loadIndex(): Promise<void> {
	loading ??= fetch(`${base}search.json`)
		.then((response) => {
			if (!response.ok) throw new Error(String(response.status));
			return response.json() as Promise<SearchEntry[]>;
		})
		.then((entries) => {
			index = entries;
		})
		.catch(() => {
			loading = null;
		});
	return loading;
}

function hrefFor(entry: SearchEntry): string {
	return `${base}${entry.slug}/${entry.anchor ? `#${entry.anchor}` : ''}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string | null,
	text?: string
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function render() {
	if (!input || !results) return;
	const query = input.value.trim();
	if (!query) {
		results.hidden = true;
		return;
	}
	results.replaceChildren();
	if (!index) {
		results.append(el('p', 'empty', 'Loading…'));
	} else if (hits.length === 0) {
		results.append(el('p', 'empty', `No results for “${query}”.`));
	} else {
		hits.forEach((hit, position) => {
			const link = el('a', null);
			link.href = hrefFor(hit.entry);
			link.setAttribute('role', 'option');
			link.setAttribute('aria-selected', String(position === selected));
			link.append(
				el('strong', null, hit.entry.heading),
				el('span', 'where', `${hit.entry.section} › ${hit.entry.page}`)
			);
			if (hit.snippet) link.append(el('span', 'snippet', hit.snippet));
			link.addEventListener('mouseenter', () => {
				selected = position;
				for (const [i, node] of [...results.children].entries())
					node.setAttribute('aria-selected', String(i === selected));
			});
			results.append(link);
		});
	}
	results.hidden = false;
}

function update() {
	selected = 0;
	hits = index && input ? searchDocs(index, input.value, 10) : [];
	render();
}

if (input && results) {
	input.addEventListener('focus', () => {
		void loadIndex().then(update);
	});
	input.addEventListener('input', update);
	input.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (hits.length === 0) return;
			selected =
				event.key === 'ArrowDown'
					? Math.min(selected + 1, hits.length - 1)
					: Math.max(selected - 1, 0);
			render();
			results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			const hit = hits[selected];
			if (hit) {
				event.preventDefault();
				location.href = hrefFor(hit.entry);
			}
		} else if (event.key === 'Escape') {
			results.hidden = true;
			input.blur();
		}
	});
	document.addEventListener('click', (event) => {
		if (!(event.target as HTMLElement).closest('[data-search]')) results.hidden = true;
	});
	document.addEventListener('keydown', (event) => {
		const typing = (event.target as HTMLElement | null)?.closest(
			'input, textarea, select, [contenteditable="true"]'
		);
		const shortcut =
			(event.key === '/' && !typing) ||
			(event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey));
		if (!shortcut) return;
		event.preventDefault();
		input.focus();
		input.select();
	});
}
