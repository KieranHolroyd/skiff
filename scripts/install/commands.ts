/**
 * Host commands in /usr/local that run code from the active release (falling back to
 * `previous`): the `yoal` CLI (D33) and the operator scripts. Shared by the installer and
 * the release's `converge` hook, so a release that adds a command also installs it on hosts that
 * only ever run `yoal-update-self`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export const CLI_COMMANDS = ['/usr/local/bin/yoal', '/usr/local/bin/yoal'];

export const RELEASE_COMMANDS: Array<{ path: string; script: string; runner: 'sh' | 'bun' }> = [
	{ path: '/usr/local/sbin/yoal-restore', script: 'repo/scripts/restore.sh', runner: 'sh' },
	{ path: '/usr/local/sbin/yoal-restore-drill', script: 'repo/scripts/yoal-restore-drill.sh', runner: 'sh' },
	{ path: '/usr/local/sbin/yoal-alert', script: 'repo/scripts/yoal-alert.ts', runner: 'bun' },
	{ path: '/usr/local/sbin/yoal-recovery-kit', script: 'repo/scripts/recovery-kit.ts', runner: 'bun' },
	{ path: '/usr/local/sbin/yoal-rotate-master-key', script: 'repo/scripts/rotate-master-key.ts', runner: 'bun' },
	{ path: '/usr/local/sbin/yoal-uninstall', script: 'repo/scripts/uninstall.sh', runner: 'sh' },
];

export interface CommandPaths {
	optDir: string;
	bunBin: string;
}

export function cliCommandScript(paths: CommandPaths): string {
	return `#!/bin/sh
# Installed by the Yoal installer: the yoal CLI from the active Yoal release.
for release in ${paths.optDir}/current ${paths.optDir}/previous; do
	if [ -f "$release/cli/yoal.js" ]; then
		exec ${paths.bunBin} "$release/cli/yoal.js" "$@"
	fi
done
echo "yoal: no release under ${paths.optDir} ships the CLI; re-run the installer" >&2
exit 1
`;
}

export function releaseCommandScript(command: (typeof RELEASE_COMMANDS)[number], paths: CommandPaths): string {
	const exec = command.runner === 'sh' ? `/bin/sh "$release/${command.script}"` : `${paths.bunBin} "$release/${command.script}"`;
	return `#!/bin/sh
# Installed by the Yoal installer: runs ${command.script} from the active Yoal release.
for release in ${paths.optDir}/current ${paths.optDir}/previous; do
	if [ -f "$release/${command.script}" ]; then
		exec ${exec} "$@"
	fi
done
echo "${basename(command.path)}: no release under ${paths.optDir} ships ${command.script}; re-run the installer" >&2
exit 1
`;
}

/** Every command path with the script it should contain. */
export function hostCommands(paths: CommandPaths): Array<{ path: string; body: string }> {
	return [
		...CLI_COMMANDS.map((path) => ({ path, body: cliCommandScript(paths) })),
		...RELEASE_COMMANDS.map((command) => ({ path: command.path, body: releaseCommandScript(command, paths) })),
	];
}

/** Atomically (re)write the commands that differ. Returns the paths written. */
export function ensureHostCommands(paths: CommandPaths, options: { log?: (message: string) => void } = {}): string[] {
	const written: string[] = [];
	for (const { path, body } of hostCommands(paths)) {
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.tmp`, body, { mode: 0o755 });
		chmodSync(`${path}.tmp`, 0o755);
		renameSync(`${path}.tmp`, path);
		options.log?.(`installed ${path}`);
		written.push(path);
	}
	return written;
}
