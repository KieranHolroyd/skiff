import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import {
	CONTAINER_SHELLS,
	ContainerConsoleClient,
	inspectReport,
	listingTable,
	parseRemote,
	runShell,
	type ContainerShell,
	type ShellIo,
} from '../containers.ts';
import { CliError, UsageError } from '../errors.ts';
import { formatBytes, printJson } from '../output.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/** Container console (D127): inspect, files, a shell and restart for a container project. */

const usage = `Usage: skif container <command> <project> [options]

Commands:
  inspect <project>                 State, image, resources, mounts and processes (the default)
  shell <project>                   Interactive shell inside the container (also \`skif shell\`)
  ls <project> [path]               List a directory (default /)
  cat <project> <path>              Print a file to stdout (bytes as they are)
  cp <project>:<path> [dest]        Download a file (dest defaults to its name here)
  restart <project>                 Restart every replica from the same image and config

Options:
  -r, --replica <n>   Replica of a multi-copy workload (default: the first)
  --shell <shell>     shell: auto (bash, else sh), /bin/bash, /bin/sh or /bin/ash
  --root              shell: run as root inside the container (capabilities stay dropped)
  -y, --yes           restart: skip the confirmation prompt
  --json              Print the raw response (inspect, ls)

Files are read-only and secret files and tmpfs mounts (/tmp) are not shown. Opening a shell and
reading a file are recorded in the audit log; keystrokes and file contents are not. Needs an API
key holding container:inspect, container:files or container:exec (\`skif login\` mints one for
your role).`;

const flags: FlagSpec = {
	replica: { type: 'string', short: 'r' },
	shell: { type: 'string', default: 'auto' },
	root: { type: 'boolean' },
	yes: { type: 'boolean', short: 'y' },
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

/** The workspace's Bun typings only declare `memoryPressure` on `process`; signals work at runtime. */
const signals = process as unknown as {
	once(event: 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
	off(event: 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
};

const SUBCOMMANDS = new Set(['inspect', 'shell', 'ls', 'cat', 'cp', 'restart']);

export async function containerCommand(argv: string[]): Promise<void> {
	const args = parseArgs(argv, flags);
	if (args.boolean('help') || args.positionals.length === 0) {
		console.log(usage);
		return;
	}
	const [first, ...rest] = args.positionals;
	const sub = SUBCOMMANDS.has(first!) ? first! : 'inspect';
	const positionals = SUBCOMMANDS.has(first!) ? rest : args.positionals;
	const replica = parseReplica(args.string('replica'));
	const client = await authenticatedClient();

	if (sub === 'cp') {
		const source = positionals[0];
		const remote = source ? parseRemote(source) : null;
		if (!remote) throw new UsageError(`cp needs <project>:<absolute path>, e.g. my-api:/data/app.db\n\n${usage}`);
		if (positionals.length > 2) throw new UsageError(usage);
		const consoleClient = new ContainerConsoleClient(client, remote.project, replica);
		const dest = await destinationFor(positionals[1], remote.path);
		const { body, size } = await consoleClient.download(remote.path);
		await pipeline(Readable.fromWeb(body as never), createWriteStream(dest));
		console.error(`Saved ${remote.path} to ${dest}${size !== null ? ` (${formatBytes(size)})` : ''}.`);
		return;
	}

	const project = positionals[0];
	if (!project) throw new UsageError(`Missing project slug.\n\n${usage}`);
	const consoleClient = new ContainerConsoleClient(client, project, replica);

	switch (sub) {
		case 'inspect': {
			if (positionals.length > 1) throw new UsageError(usage);
			const { targets, container, raw } = await consoleClient.inspect();
			if (args.boolean('json')) return printJson(raw);
			if (!container) throw new CliError(`${project} has no container to inspect.`, { code: 'not_found' });
			if (targets.length > 1 && replica === null)
				console.log(`${targets.length} replicas; showing #${targets[0]!.replica ?? 0}. Pick another with --replica.\n`);
			const target = targets.find((item) => item.replica === replica) ?? targets[0];
			console.log(inspectReport(container, target).join('\n'));
			return;
		}
		case 'ls': {
			if (positionals.length > 2) throw new UsageError(usage);
			const listing = await consoleClient.list(positionals[1] ?? '/');
			if (args.boolean('json')) return printJson(listing);
			console.log(`${listing.path}  (${listing.mount === '/' ? 'image filesystem' : `mount ${listing.mount}`}${listing.readOnly ? ', read-only' : ''})`);
			console.log(listingTable(listing));
			return;
		}
		case 'cat': {
			rejectExtraPositionals(args, 3, usage);
			const path = requirePositional(args, 2, 'path');
			const { body } = await consoleClient.download(path);
			await pipeline(Readable.fromWeb(body as never), process.stdout);
			return;
		}
		case 'restart': {
			if (positionals.length > 1) throw new UsageError(usage);
			const confirmed = await confirmOrRefuse(
				`Restart every replica of ${project}? Open shells close and requests fail for a few seconds. [y/N] `,
				{ yes: args.boolean('yes'), refusal: `Restarting ${project} needs confirmation.` },
			);
			if (!confirmed) {
				console.log('Not restarted.');
				return;
			}
			const result = await consoleClient.restart();
			console.log(result.message ?? 'Restart requested.');
			return;
		}
		case 'shell': {
			if (positionals.length > 1) throw new UsageError(usage);
			const shell = args.string('shell') ?? 'auto';
			if (!(CONTAINER_SHELLS as readonly string[]).includes(shell))
				throw new UsageError(`--shell must be one of ${CONTAINER_SHELLS.join(', ')}.`);
			const code = await interactiveShell(consoleClient, shell as ContainerShell, args.boolean('root') ? 'root' : 'default');
			process.exitCode = code < 0 ? 1 : code;
			return;
		}
	}
}

/** `skif shell <project>`: the same as `skif container shell <project>`. */
export async function shellCommand(argv: string[]): Promise<void> {
	if (argv.includes('-h') || argv.includes('--help')) {
		console.log(
			'Usage: skif shell <project> [--shell auto|/bin/bash|/bin/sh|/bin/ash] [--root] [--replica <n>]\n\nOpen an interactive shell inside a container project. Exit the shell (Ctrl-D or `exit`) to leave.',
		);
		return;
	}
	await containerCommand(['shell', ...argv]);
}

async function interactiveShell(
	consoleClient: ContainerConsoleClient,
	shell: ContainerShell,
	user: 'default' | 'root',
): Promise<number> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const tty = stdin.isTTY === true;
	const io: ShellIo = {
		cols: () => stdout.columns || 80,
		rows: () => stdout.rows || 24,
		write: (bytes) => {
			stdout.write(bytes);
		},
		onInput: (listener) => {
			if (tty) stdin.setRawMode(true);
			const onData = (chunk: Buffer) => listener(new Uint8Array(chunk));
			stdin.on('data', onData);
			stdin.resume();
			return () => {
				stdin.off('data', onData);
				if (tty) stdin.setRawMode(false);
				stdin.pause();
			};
		},
		onResize: (listener) => {
			stdout.on('resize', listener);
			return () => stdout.off('resize', listener);
		},
		notice: (message) => process.stderr.write(`\r\n[skif: ${message}]\r\n`),
	};
	// Raw mode turns Ctrl-C into a keystroke for the remote shell; a terminating signal still
	// restores the terminal and hangs the shell up.
	const restore = () => {
		if (tty) stdin.setRawMode(false);
	};
	signals.once('SIGTERM', restore);
	signals.once('SIGHUP', restore);
	try {
		const code = await runShell(consoleClient, io, { shell, user });
		if (code > 0) process.stderr.write(`[skif: shell exited with code ${code}${code === 126 || code === 127 ? ' — the image may have no such shell (distroless images have none)' : ''}]\n`);
		return code;
	} finally {
		restore();
		signals.off('SIGTERM', restore);
		signals.off('SIGHUP', restore);
	}
}

function parseReplica(value: string | undefined): number | null {
	if (value === undefined) return null;
	const replica = Number(value);
	if (!Number.isInteger(replica) || replica < 0 || replica > 999) throw new UsageError('--replica must be a replica index (0, 1, …).');
	return replica;
}

async function destinationFor(dest: string | undefined, remotePath: string): Promise<string> {
	const name = basename(remotePath) || 'download';
	if (!dest) return name;
	try {
		if ((await stat(dest)).isDirectory()) return join(dest, name);
	} catch {
		// Not there yet: it is the file name.
	}
	return dest;
}
