import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec, type ParsedArgs } from '../args.ts';
import { parseCpus, parseMegabytes } from '../databases.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import {
	capacityTable,
	parseEnvPair,
	parseSecretRef,
	splitCommand,
	workloadDetails,
	type WorkloadSecretRef,
	type WorkloadSpec,
} from '../workloads.ts';
import { authenticatedClient } from './common.ts';
import { confirmOrRefuse } from './run-operation.ts';

/**
 * The project runtime spec (DESIGN §3.4): what the dashboard's Runtime tab edits and what
 * `PUT /api/v1/projects/:slug/workload` saves. Validation and admission stay on the platform.
 */

const usage = `Usage: skif workload <command> [options]

Commands:
  show <project>               Show the saved runtime spec and the running workload
  set <project> [options]      Save runtime settings (merges with what is already saved)
  reset <project>              Stop the workload and clear the saved spec (releases are kept)
  capacity                     Per-node workload-slice reservation (platform admin)

Set options:
  -p, --project <slug>         Project slug (also accepted as the first argument)
      --command <cmd>          Process command, split on spaces (no shell quotes)
      --engine <bun|node>      Process engine (Node.js needs the node's pinned Node)
      --image <ref>            Container image (container projects)
      --port <n>               Port the app listens on (default 3000)
      --memory <size>          Memory reservation, e.g. 256M or 1G (default 256M)
      --cpus <n>               CPU quota, e.g. 1 or 0.5
      --health-path <path>     Health/proxy check path (default /)
      --[no-]socket-activation Pass the listen socket (process apps; default on)
      --idle-stop <seconds>    Stop after this long without a request (0 = always on)
      --ingress <http|none>    http serves traffic; none makes a worker (needs --replicas)
      --replicas <n>           Identical copies on the same node (1-20)
      --data <size|none>       Persistent /data directory (e.g. 512M), or none
      --env KEY=value          Plain variable (repeatable; merges with saved ones)
      --unset-env KEY          Remove a plain variable (repeatable)
      --secret NAME[=ver][:file]
                               Add or replace a secret reference (repeatable)
      --clear-secrets          Remove every secret reference
      --json                   Print the raw response
  -h, --help                   Show this help

Examples:
  skif workload show shop
  skif workload set shop --engine node --port 8080 --memory 512M --idle-stop 300
  skif workload set api --image ghcr.io/acme/api:1.4 --memory 1G
  skif workload set shop --env NODE_ENV=production --secret STRIPE_KEY=2
  skif workload reset shop --yes

The Variables tab's new secret values are not set here: create the secret first, then reference
it by name. A reference without a version uses the latest version at activation.`;

const baseFlags: FlagSpec = {
	json: { type: 'boolean' },
	help: { type: 'boolean', short: 'h' },
};

const showFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
};

const setFlags: FlagSpec = {
	...baseFlags,
	project: { type: 'string', short: 'p' },
	command: { type: 'string' },
	engine: { type: 'string' },
	image: { type: 'string' },
	port: { type: 'string' },
	memory: { type: 'string' },
	cpus: { type: 'string' },
	'health-path': { type: 'string' },
	'socket-activation': { type: 'boolean' },
	'idle-stop': { type: 'string' },
	ingress: { type: 'string' },
	replicas: { type: 'string' },
	data: { type: 'string' },
	env: { type: 'string', multiple: true },
	'unset-env': { type: 'string', multiple: true },
	secret: { type: 'string', multiple: true },
	'clear-secrets': { type: 'boolean' },
};

const resetFlags: FlagSpec = { ...baseFlags, project: { type: 'string', short: 'p' }, yes: { type: 'boolean', short: 'y' } };

const subcommands: Record<string, (argv: string[]) => Promise<void>> = {
	show,
	get: show,
	set,
	update: set,
	reset,
	remove: reset,
	capacity,
	cap: capacity,
};

export async function workloadCommand(argv: string[]): Promise<void> {
	const first = argv[0];
	if (first && !first.startsWith('-')) {
		const handler = subcommands[first];
		if (!handler) throw new UsageError(`Unknown workload command "${first}".\n\n${usage}`);
		await handler(argv.slice(1));
		return;
	}
	await show(argv);
}

/** Accept either `skif workload show <project>` or `skif workload show --project <project>`. */
function projectOf(args: ParsedArgs, index = 0): string {
	const flag = args.string('project');
	const positional = args.positionals[index];
	const project = flag ?? positional;
	if (!project) throw new UsageError('Name the project: skif workload show <project>.');
	if (flag && positional && flag !== positional)
		throw new UsageError(`Two different projects were given ("${flag}" and "${positional}").`);
	return project;
}

async function show(argv: string[]): Promise<void> {
	const args = parseArgs(argv, showFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif workload show <project> [--json]');
	const project = projectOf(args);
	const client = await authenticatedClient();
	const [{ project: view, raw: projectRaw }, { spec, workload, raw }] = await Promise.all([
		client.getProject(project),
		client.getWorkload(project),
	]);
	if (args.boolean('json')) {
		printJson({ project: projectRaw, workload: raw });
		return;
	}
	console.log(`Project     ${view.slug}`);
	console.log(`Runtime     ${view.runtime ?? spec?.runtime ?? 'unknown'}`);
	console.log('');
	console.log(workloadDetails(spec, workload).join('\n'));
}

function numberFlag(args: ParsedArgs, name: string, label: string, options: { min: number; max: number; integer?: boolean }): number {
	const raw = args.string(name);
	if (raw === undefined) throw new UsageError(`Missing --${name}.`);
	const value = Number(raw);
	if (!Number.isFinite(value))
		throw new UsageError(`${label} expects a number, got "${raw}".`);
	if (options.integer && !Number.isInteger(value)) throw new UsageError(`${label} expects a whole number.`);
	if (value < options.min || value > options.max)
		throw new UsageError(`${label} must be between ${options.min} and ${options.max}.`);
	return value;
}

async function set(argv: string[]): Promise<void> {
	const args = parseArgs(argv, setFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif workload set <project> [options]');
	const project = projectOf(args);
	const client = await authenticatedClient();
	const { project: view } = await client.getProject(project);
	if (view.runtime === 'static')
		throw new CliError(
			`Project "${project}" is static and serves files; it has no workload to configure.`,
			{ code: 'runtime_mismatch', suggestions: ['Create the project with runtime "process" or "container".'] },
		);
	if (view.runtime === 'function')
		throw new CliError(
			`Project "${project}" is a function; its runtime comes from skiff-function.json in the bundle.`,
			{ code: 'runtime_mismatch' },
		);

	const { spec: current } = await client.getWorkload(project);
	const spec: WorkloadSpec = { ...(current ?? { runtime: view.runtime ?? 'process' }) };
	const runtime = spec.runtime;

	if (args.has('command')) {
		const command = splitCommand(args.string('command') ?? '');
		if (command.length === 0) throw new UsageError('--command cannot be empty. Use --help to see the fields.');
		spec.command = command;
	}
	if (args.has('engine')) {
		const engine = args.string('engine');
		if (engine !== 'bun' && engine !== 'node') throw new UsageError('--engine must be bun or node.');
		spec.engine = engine;
	}
	if (args.has('image')) spec.image = args.string('image') ?? '';
	if (args.has('port')) spec.port = numberFlag(args, 'port', '--port', { min: 1, max: 65535, integer: true });
	if (args.has('memory')) spec.memoryMb = parseMegabytes(args.string('memory') ?? '', '--memory');
	if (args.has('cpus')) spec.cpus = parseCpus(args.string('cpus') ?? '');
	if (args.has('health-path')) {
		const path = args.string('health-path') ?? '';
		if (!path.startsWith('/')) throw new UsageError('--health-path must start with "/".');
		spec.healthPath = path;
	}
	if (args.has('socket-activation')) spec.socketActivation = args.boolean('socket-activation');
	if (args.has('idle-stop')) spec.idleStopSeconds = numberFlag(args, 'idle-stop', '--idle-stop', { min: 0, max: 86_400, integer: true });
	if (args.has('ingress')) {
		const ingress = args.string('ingress');
		if (ingress !== 'http' && ingress !== 'none') throw new UsageError('--ingress must be http or none.');
		spec.ingress = ingress;
	}
	if (args.has('replicas')) spec.replicas = numberFlag(args, 'replicas', '--replicas', { min: 1, max: 20, integer: true });
	if (args.has('data')) {
		const value = (args.string('data') ?? '').toLowerCase();
		if (value === 'none' || value === 'off' || value === '0') delete spec.data;
		else spec.data = { sizeMb: parseMegabytes(value, '--data') };
	}

	if (args.strings('env').length > 0) {
		const env = { ...(spec.env ?? {}) };
		for (const pair of args.strings('env')) {
			const [name, value] = parseEnvPair(pair);
			env[name] = value;
		}
		spec.env = env;
	}
	if (args.strings('unset-env').length > 0) {
		const env = { ...(spec.env ?? {}) };
		for (const name of args.strings('unset-env')) delete env[name];
		spec.env = env;
	}
	if (args.strings('secret').length > 0) {
		const refs = new Map<string, WorkloadSecretRef>();
		for (const ref of spec.secrets ?? []) refs.set(ref.name, ref);
		for (const value of args.strings('secret')) {
			try {
				const ref = parseSecretRef(value);
				refs.set(ref.name, ref);
			} catch (error) {
				throw new UsageError((error as Error).message);
			}
		}
		spec.secrets = [...refs.values()];
	}
	if (args.boolean('clear-secrets')) spec.secrets = [];

	if (runtime === 'container' && spec.command) delete spec.command;
	if (runtime === 'process' && spec.image) delete spec.image;

	const { workload, raw } = await client.setWorkload(project, spec);
	if (args.boolean('json')) {
		printJson({ sent: spec, saved: raw });
		return;
	}
	console.log(`Saved runtime for ${project}.`);
	console.log('');
	console.log(workloadDetails(spec, workload).join('\n'));
	if (!current && !workload)
		console.log('\nIt applies at the next deployment (or when the app is next reconciled).');
}

async function reset(argv: string[]): Promise<void> {
	const args = parseArgs(argv, resetFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 1, 'Usage: skif workload reset <project> [--yes]');
	const project = projectOf(args);
	await confirmOrRefuse(
		`Stop the workload for ${project} and clear its saved runtime spec? Releases are kept, but the app stays dark until it is configured and deployed again. [y/N] `,
		{
			yes: args.boolean('yes'),
			refusal: 'Confirmation required to reset a runtime. Re-run with --yes.',
		},
	);
	const client = await authenticatedClient();
	const { raw } = await client.resetWorkload(project);
	if (args.boolean('json')) printJson(raw);
	else console.log(`Runtime cleared for ${project}. The workload stops on the next reconcile.`);
}

async function capacity(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: skif workload capacity [--json]');
	const client = await authenticatedClient();
	const { capacity: nodes, raw } = await client.getNodeCapacity();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(capacityTable(nodes));
}
