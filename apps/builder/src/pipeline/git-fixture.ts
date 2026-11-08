import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A throwaway local git repository for clone/resolve/executor tests. */
export function gitRepo(dir: string): { commit(files: Record<string, string>, message: string): string; dir: string } {
	mkdirSync(dir, { recursive: true });
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(['git', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: dir });
		if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
		return result.stdout.toString().trim();
	};
	git('init', '--quiet', '--initial-branch=main');
	return {
		dir,
		commit(files, message) {
			for (const [path, content] of Object.entries(files)) {
				mkdirSync(dirname(join(dir, path)), { recursive: true });
				writeFileSync(join(dir, path), content);
			}
			git('add', '-A');
			git('commit', '--quiet', '-m', message);
			return git('rev-parse', 'HEAD');
		},
	};
}
