import { readFile } from 'node:fs/promises';
import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import {
	invokeSummary,
	isSuccessStatus,
	normalizeRequestPath,
	parseHeaderFlags,
	parseMethod,
	responseBodyBytes,
	responseHead,
	scheduledFailed,
	scheduledSummary,
} from '../functions.ts';
import { formatBytes, printJson } from '../output.ts';
import { readAllStdin } from '../prompt.ts';
import { authenticatedClient } from './common.ts';

/** Test tools for function projects (D124). They run on the function's node; the server validates. */

const usage = `Usage: yoal function <command> [options]

Commands:
  invoke <project> [path]      Send one test request to the function (default GET /)
  cron <project> <cron>        Run the scheduled() handler now for one of its crons

Both run on the function's node and go straight to its host, bypassing domains, Caddy and
access rules. An idle-stopped function starts for the request (shown as "cold start").

Invoke options:
  -X, --method <method>        GET (default), HEAD, POST, PUT, PATCH, DELETE or OPTIONS;
                               POST when a body is given
  -H, --header 'Name: value'   Request header (repeatable)
  -d, --data <body>            Request body
      --data-file <path>       Request body from a file (- reads stdin)
  -i, --include                Print the status line and response headers before the body

Options:
      --json                   Print the task with its raw result
  -h, --help                   Show this help

The response body goes to stdout and a summary line (status, time, cold start) to stderr.
Both commands exit 1 when the function answers with an error: a non-2xx status for invoke,
status 400 or more or a thrown error for cron.

Examples:
  yoal function invoke api /health
  yoal fn invoke api /users -X POST -H 'content-type: application/json' -d '{"name":"Ada"}'
  yoal fn cron api '*/5 * * * *'`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};
const invokeFlags: FlagSpec = {
	...baseFlags,
	method: { type: 'string', short: 'X' },
	header: { type: 'string', short: 'H', multiple: true },
	data: { type: 'string', short: 'd' },
	'data-file': { type: 'string' },
	include: { type: 'boolean', short: 'i' },
};

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	invoke: invokeFunction,
	call: invokeFunction,
	request: invokeFunction,
	cron: runCron,
	scheduled: runCron,
};

export async function functionCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (!first || first === '--help' || first === '-h' || first === 'help') {
		console.log(usage);
		return;
	}
	const handler = subcommands[first];
	if (!handler) throw new UsageError(`Unknown function command "${first}".\n\n${usage}`);
	await handler(argv.slice(1));
}

async function requestBody(args: ReturnType<typeof parseArgs>): Promise<string | undefined> {
	const data = args.string('data');
	const file = args.string('data-file');
	if (data !== undefined && file !== undefined) throw new UsageError('Use -d/--data or --data-file, not both.');
	if (file === undefined) return data;
	try {
		return file === '-' ? await readAllStdin() : await readFile(file, 'utf8');
	} catch (error) {
		throw new UsageError(`Could not read --data-file ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Dim when stderr is a colour terminal; plain text otherwise. */
function note(line: string, dim: boolean): void {
	const colour = dim && process.stderr.isTTY && !process.env.NO_COLOR;
	process.stderr.write(colour ? `\x1b[2m${line}\x1b[0m\n` : `${line}\n`);
}

async function invokeFunction(argv: string[]): Promise<void> {
	const args = parseArgs(argv, invokeFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal function invoke <project> [path] [-X <method>] [-H "Name: value"] [-d <body>]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `project.\n\n${line}`);
	const path = normalizeRequestPath(args.positionals[1]);
	const headers = parseHeaderFlags(args.strings('header'));
	const body = await requestBody(args);
	const method = parseMethod(args.string('method'), body !== undefined);

	const client = await authenticatedClient();
	const { result, raw } = await client.functionInvoke(project, {
		method,
		path,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		...(body !== undefined ? { body } : {}),
	});
	const ok = isSuccessStatus(result.status);
	if (!ok) process.exitCode = 1;
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}

	if (args.boolean('include')) process.stdout.write(`${responseHead(result)}\n\n`);
	const bytes = responseBodyBytes(result);
	if (result.encoding === 'base64' && process.stdout.isTTY && bytes.length > 0) {
		note(`Binary body (${formatBytes(result.size)}) not shown on a terminal. Redirect stdout to a file, or use --json.`, false);
	} else if (bytes.length > 0) {
		process.stdout.write(bytes);
		if (process.stdout.isTTY && bytes[bytes.length - 1] !== 0x0a) process.stdout.write('\n');
	}
	note(invokeSummary(result), ok);
}

async function runCron(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = "Usage: yoal function cron <project> '<cron>'";
	if (args.positionals.length > 2)
		throw new UsageError(`Quote the cron expression so the shell passes it as one argument.\n\n${line}`);
	const project = requirePositional(args, 0, `project.\n\n${line}`);
	const cron = requirePositional(args, 1, `cron expression (one of the function's triggers.crons, quoted).\n\n${line}`);
	const client = await authenticatedClient();
	const { result, raw } = await client.functionScheduled(project, cron);
	const failed = scheduledFailed(result);
	if (failed) process.exitCode = 1;
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (failed) console.error(scheduledSummary(cron, result));
	else console.log(scheduledSummary(cron, result));
}
