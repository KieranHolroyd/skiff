<script lang="ts">
	import { highlight, type HighlightToken } from './highlight.js';

	/**
	 * A read-only `<pre><code>` block with syntax colours. Renders plain text straight away and
	 * swaps in tokens once the grammar has loaded, so there is no layout shift and nothing breaks
	 * if highlighting fails. `lang` takes a language, fence tag or file label (see resolveLang).
	 * Set `plain` to skip highlighting, e.g. while a reply is still streaming in.
	 */
	let {
		code,
		lang,
		plain = false,
		class: className = ''
	}: { code: string; lang?: string | null; plain?: boolean; class?: string } = $props();

	let lines = $state<HighlightToken[][] | null>(null);
	let request = 0;
	const NEWLINE = '\n';

	$effect(() => {
		const id = ++request;
		const source = code;
		const hint = lang;
		if (plain) {
			lines = null;
			return;
		}
		void highlight(source, hint).then((result) => {
			if (id === request) lines = result;
		});
	});
</script>

<pre class="hl {className}"><code
		>{#if lines}{#each lines as line, index (index)}{#if index > 0}{NEWLINE}{/if}{#each line as token, tokenIndex (tokenIndex)}{#if token.style}<span
							style={token.style}>{token.text}</span
						>{:else}{token.text}{/if}{/each}{/each}{:else}{code}{/if}</code
	></pre>
