/**
 * Headless Mermaid syntax check for docs diagrams. Mermaid's parser runs under Bun, but it calls
 * DOMPurify hooks that only exist with a DOM, so those are stubbed (parsing never sanitises).
 */
import DOMPurify from 'dompurify';

const purify = DOMPurify as unknown as Record<string, unknown>;
purify.addHook ??= () => {};
purify.removeHook ??= () => {};
purify.removeAllHooks ??= () => {};
purify.sanitize ??= (value: string) => value;

const { default: mermaid } = await import('mermaid');

/** `null` when the diagram parses, otherwise the parser's first error line. */
export async function mermaidError(source: string): Promise<string | null> {
	try {
		await mermaid.parse(source);
		return null;
	} catch (error) {
		return ((error as Error).message ?? String(error)).split('\n').slice(0, 3).join(' ').trim();
	}
}
