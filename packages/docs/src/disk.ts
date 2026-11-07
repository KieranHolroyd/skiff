import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The content directory shipped with this package. */
export const CONTENT_DIR = join(import.meta.dir, '..', 'content');

/**
 * Every Markdown page under `content/`, keyed by slug, read from disk. For Bun/Node hosts (the
 * standalone site's build, tests); the dashboard inlines the same files through Vite instead.
 */
export function readContent(dir: string = CONTENT_DIR): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith('.md'))
				out[relative(dir, path).replace(/\\/g, '/').replace(/\.md$/, '')] = readFileSync(path, 'utf8');
		}
	};
	walk(dir);
	return out;
}
