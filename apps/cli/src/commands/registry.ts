import { parseArgs, rejectExtraPositionals, requirePositional, type FlagSpec } from '../args.ts';
import { UsageError } from '../errors.ts';
import { formatTime, printJson, renderTable } from '../output.ts';
import { promptText } from '../prompt.ts';
import type { RegistryCredentialView } from '../api.ts';
import { authenticatedClient, authenticatedContext } from './common.ts';
import { spawn } from 'node:child_process';
import { confirmOrRefuse } from './run-operation.ts';
import { pruneCommand } from './prune.ts';

/**
 * Container registries (docs/REGISTRY.md). Credentials let nodes pull private images from GHCR,
 * Docker Hub or any other registry; `deploy` points a container project at an image and deploys it.
 */

const usage = `Usage: yoal registry <command> [options]

Commands:
  status                               The platform registry: host, node and status (the default)
  login [--engine docker|podman]       Log docker (or podman) in to the registry with this profile's API key
  repos                                Your organisation's repositories, with the last push
  tags <org>/<name>                    Tags of one repository
  untag <org>/<name> <tag>             Delete a tag (needs image:delete; the registry frees unused layers later)
  prune                                Delete old tags by retention (dry run by default; see \`yoal prune --help\`)
  autodeploy <org>/<name> <project>    Deploy every push of --tag (default latest) to a container project; --off stops it
  scan <org>/<name>[:<tag>]            Vulnerabilities from the registry's scan (when a platform admin turned it on)
  trust [list|add|rm]                  Let a GitHub repository's workflows push with their OIDC token (no stored secret)
  credentials                          List credentials for external registries
  credentials add <name> <registry>    Store a login for a registry host (--username; password from a prompt or --password-stdin)
  credentials update <name>            Change the host, username or password
  credentials rm <name>                Delete a credential (running containers keep their image)
  deploy <project> <image>             Point a container project at an image and deploy it

Credential options:
  -u, --username <user>                Registry username (GitHub: your user or org; Docker Hub: your account)
      --password-stdin                 Read the password or access token from stdin
      --registry <host>                update: move the credential to another host

Deploy options:
      --no-promote                     Create a preview only, do not move production
  -m, --message <text>                 Deployment message
  -e, --environment <slug>             Deploy to a named environment

Options:
  -y, --yes                            Don't ask for confirmation (required when stdin isn't a terminal)
      --json                           JSON output
  -h, --help                           Show this help

A deploy resolves the image's tag to a digest, so the deployment (and a rollback to it) always runs the
same image. Credentials are matched to an image by registry host: one credential per host per org.

Examples:
  yoal registry login && docker push $(yoal registry status --host)/my-org/api:1
  echo "$GHCR_TOKEN" | yoal registry credentials add ghcr ghcr.io -u my-org --password-stdin
  yoal registry deploy cairn ghcr.io/my-org/cairn:2026-11-07`;

const baseFlags: FlagSpec = { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } };
const credentialFlags: FlagSpec = {
	...baseFlags,
	username: { type: 'string', short: 'u' },
	'password-stdin': { type: 'boolean' },
	registry: { type: 'string' },
};
const confirmFlags: FlagSpec = { ...baseFlags, yes: { type: 'boolean', short: 'y' } };
const deployFlags: FlagSpec = {
	...baseFlags,
	promote: { type: 'boolean', default: true },
	message: { type: 'string', short: 'm' },
	environment: { type: 'string', short: 'e' },
};

export async function registryCommand(argv: string[]): Promise<void> {
	const [first, ...rest] = argv;
	if (!first || first.startsWith('-')) {
		if (first === '-h' || first === '--help') {
			console.log(usage);
			return;
		}
		return showStatus(argv);
	}
	if (first === 'status') return showStatus(rest);
	if (first === 'login') return login(rest);
	if (first === 'repos' || first === 'repositories' || first === 'ls') return listRepositories(rest);
	if (first === 'tags') return listTags(rest);
	if (first === 'untag') return untag(rest);
	if (first === 'prune') return pruneCommand(['--only', 'registry_images', ...rest]);
	if (first === 'autodeploy' || first === 'auto-deploy') return autoDeploy(rest);
	if (first === 'scan') return scan(rest);
	if (first === 'trust' || first === 'trusts') return trust(rest);
	if (first === 'deploy') return deployImage(rest);
	if (first === 'credentials' || first === 'credential' || first === 'creds') {
		const [action, ...args] = rest;
		if (!action || action.startsWith('-')) return listCredentials(rest);
		if (action === 'list' || action === 'ls') return listCredentials(args);
		if (action === 'add' || action === 'create') return addCredential(args);
		if (action === 'update' || action === 'set') return updateCredential(args);
		if (action === 'rm' || action === 'remove' || action === 'delete') return removeCredential(args);
		throw new UsageError(`Unknown registry credentials command "${action}".\n\n${usage}`);
	}
	throw new UsageError(`Unknown registry command "${first}".\n\n${usage}`);
}

export function credentialTable(credentials: RegistryCredentialView[]): string {
	return renderTable(
		['NAME', 'REGISTRY', 'USERNAME', 'LAST USED', 'UPDATED'],
		credentials.map((row) => [
			row.name,
			row.registry,
			row.username,
			row.lastUsedAt ? formatTime(row.lastUsedAt) : 'never',
			formatTime(row.updatedAt),
		]),
	);
}

async function listCredentials(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal registry credentials [--json]');
	const client = await authenticatedClient();
	const { credentials, raw } = await client.listRegistryCredentials();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (credentials.length === 0) {
		console.log('No registry credentials. Add one with `yoal registry credentials add <name> <registry> -u <user>`.');
		return;
	}
	console.log(credentialTable(credentials));
}

async function readPassword(fromStdin: boolean): Promise<string> {
	const password = await promptText(fromStdin ? '' : 'Password or access token: ', { secret: true });
	if (!password) throw new UsageError('No password given. Pipe it with --password-stdin or type it at the prompt.');
	return password;
}

async function addCredential(argv: string[]): Promise<void> {
	const args = parseArgs(argv, credentialFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry credentials add <name> <registry> -u <username> [--password-stdin]';
	rejectExtraPositionals(args, 2, line);
	const name = requirePositional(args, 0, `a credential name.\n\n${line}`);
	const registry = requirePositional(args, 1, `the registry host, e.g. ghcr.io.\n\n${line}`);
	const username = args.string('username');
	if (!username) throw new UsageError(`Give the registry username with -u.\n\n${line}`);
	const password = await readPassword(args.boolean('password-stdin'));
	const client = await authenticatedClient();
	const { credential, raw } = await client.createRegistryCredential({ name, registry, username, password });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Stored ${credential.name} for ${credential.registry} (${credential.username}). Nodes pull ${credential.registry} images with it from the next deploy or retry.`);
}

async function updateCredential(argv: string[]): Promise<void> {
	const args = parseArgs(argv, credentialFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry credentials update <name> [--registry <host>] [-u <username>] [--password-stdin]';
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `the credential name.\n\n${line}`);
	const input: { registry?: string; username?: string; password?: string } = {};
	const registry = args.string('registry');
	const username = args.string('username');
	if (registry) input.registry = registry;
	if (username) input.username = username;
	if (args.boolean('password-stdin') || (!registry && !username)) input.password = await readPassword(args.boolean('password-stdin'));
	const client = await authenticatedClient();
	const { credential, raw } = await client.updateRegistryCredential(name, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(`Updated ${credential.name} (${credential.registry}, ${credential.username}).`);
}

async function removeCredential(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry credentials rm <name> [--yes]';
	rejectExtraPositionals(args, 1, line);
	const name = requirePositional(args, 0, `the credential name.\n\n${line}`);
	const ok = await confirmOrRefuse(`Delete registry credential ${name}? Private images from its registry stop pulling. [y/N] `, {
		yes: args.boolean('yes'),
		refusal: 'Not deleted. Pass --yes to delete without asking.',
	});
	if (!ok) return;
	const client = await authenticatedClient();
	await client.deleteRegistryCredential(name);
	if (args.boolean('json')) {
		printJson({ deleted: true });
		return;
	}
	console.log(`Deleted ${name}.`);
}

async function deployImage(argv: string[]): Promise<void> {
	const args = parseArgs(argv, deployFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry deploy <project> <image> [--no-promote] [-m <message>] [-e <environment>]';
	rejectExtraPositionals(args, 2, line);
	const project = requirePositional(args, 0, `the project slug.\n\n${line}`);
	const image = requirePositional(args, 1, `the image, e.g. ghcr.io/acme/api:1.2.\n\n${line}`);
	const client = await authenticatedClient();
	const input: { image: string; promote?: boolean; message?: string; environment?: string } = {
		image,
		promote: args.boolean('promote'),
	};
	const message = args.string('message');
	const environment = args.string('environment');
	if (message) input.message = message;
	if (environment) input.environment = environment;
	const { deployment, workload, raw } = await client.deployImage(project, input);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const pinned = workload?.imageDigest ? `pinned to ${workload.imageDigest.slice(0, 19)}…` : 'running by tag (not pinned)';
	console.log(`Deployed ${image} to ${project} as ${deployment.shortId ?? deployment.id ?? '?'}, ${pinned}.`);
	const url = deployment.productionUrl ?? deployment.previewUrl ?? deployment.url;
	if (url) console.log(url);
}

async function showStatus(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, host: { type: 'boolean' } });
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal registry status [--host] [--json]');
	const client = await authenticatedClient();
	const { registry, raw } = await client.getRegistry();
	if (args.boolean('host')) {
		console.log(registry.host);
		return;
	}
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (!registry.enabled) {
		console.log('The platform registry is off. A platform admin turns it on in Settings → Container registries.');
		return;
	}
	console.log(`${registry.host}  ${registry.status}  (${registry.engine} ${registry.version} on ${registry.node?.name ?? '?'}, keeps ${registry.keepTags} tags per repository)`);
	console.log(`Push to ${registry.host}/<your org>/<name>:<tag> after \`yoal registry login\`.`);
}

async function login(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, engine: { type: 'string' }, print: { type: 'boolean' } });
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal registry login [--engine docker|podman] [--print]');
	const { client, config } = await authenticatedContext();
	const { registry } = await client.getRegistry();
	if (!registry.enabled) throw new UsageError('The platform registry is off; a platform admin turns it on in Settings → Container registries.');
	const engine = args.string('engine') ?? 'docker';
	if (engine !== 'docker' && engine !== 'podman') throw new UsageError('--engine must be docker or podman.');
	if (args.boolean('print')) {
		console.log(`${engine} login ${registry.host} -u yoal --password-stdin   # paste your Yoal API key (yoal_…)`);
		return;
	}
	if (!config.token) throw new UsageError('This profile has no API key; run `yoal login` first.');
	// The API key is the registry password; the realm checks it like the REST API does.
	await new Promise<void>((resolve, reject) => {
		const child = spawn(engine, ['login', registry.host, '-u', 'yoal', '--password-stdin'], { stdio: ['pipe', 'inherit', 'inherit'] });
		child.on('error', (error) => reject(new UsageError(`Could not run ${engine}: ${error.message}. Use --engine or --print.`)));
		child.on('exit', (code) => (code === 0 ? resolve() : reject(new UsageError(`${engine} login exited with ${code}.`))));
		child.stdin.end(`${config.token}\n`);
	});
}

async function listRepositories(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	rejectExtraPositionals(args, 0, 'Usage: yoal registry repos [--json]');
	const client = await authenticatedClient();
	const { repositories, raw } = await client.listRegistryRepositories();
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	if (repositories.length === 0) {
		console.log('No repositories yet. Push to <registry host>/<your org>/<name>:<tag> to create one.');
		return;
	}
	console.log(
		renderTable(
			['REPOSITORY', 'PROJECT', 'DEPLOY ON PUSH', 'LAST TAG', 'DIGEST', 'PUSHED'],
			repositories.map((row) => [
				row.name,
				row.projectSlug ?? '—',
				row.deploy ? `:${row.deploy.tag} → ${row.deploy.project ?? '?'}` : '—',
				row.lastTag ?? '—',
				row.lastDigest ? `${row.lastDigest.slice(0, 19)}…` : '—',
				row.lastPushAt ? formatTime(row.lastPushAt) : '—',
			]),
		),
	);
}

async function listTags(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry tags <org>/<name> [--json]';
	rejectExtraPositionals(args, 1, line);
	const repository = requirePositional(args, 0, `the repository.\n\n${line}`);
	const client = await authenticatedClient();
	const { tags, raw } = await client.listRegistryTags(repository);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(tags.length === 0 ? 'No tags.' : tags.map((row) => row.tag).join('\n'));
}

async function untag(argv: string[]): Promise<void> {
	const args = parseArgs(argv, confirmFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry untag <org>/<name> <tag> [--yes]';
	rejectExtraPositionals(args, 2, line);
	const repository = requirePositional(args, 0, `the repository.\n\n${line}`);
	const tag = requirePositional(args, 1, `the tag.\n\n${line}`);
	const ok = await confirmOrRefuse(`Delete ${repository}:${tag}? Deployments pinned to its digest keep running. [y/N] `, {
		yes: args.boolean('yes'),
		refusal: 'Not deleted. Pass --yes to delete without asking.',
	});
	if (!ok) return;
	const client = await authenticatedClient();
	await client.deleteRegistryTag(repository, tag);
	console.log(`Deleted ${repository}:${tag}.`);
}

async function autoDeploy(argv: string[]): Promise<void> {
	const args = parseArgs(argv, { ...baseFlags, tag: { type: 'string', short: 't' }, off: { type: 'boolean' } });
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry autodeploy <org>/<name> <project> [--tag latest] | yoal registry autodeploy <org>/<name> --off';
	rejectExtraPositionals(args, 2, line);
	const repository = requirePositional(args, 0, `the repository.\n\n${line}`);
	const off = args.boolean('off');
	const project = off ? null : requirePositional(args, 1, `the project to deploy to (or --off).\n\n${line}`);
	const tag = args.string('tag');
	const client = await authenticatedClient();
	const { repository: view, raw } = await client.setRegistryAutoDeploy({ repository, project, ...(tag ? { tag } : {}) });
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	console.log(
		view.deploy
			? `Every push of ${repository}:${view.deploy.tag} now deploys to ${view.deploy.project}, pinned to the pushed digest.`
			: `Pushes to ${repository} no longer deploy anywhere.`,
	);
}

async function scan(argv: string[]): Promise<void> {
	const args = parseArgs(argv, baseFlags);
	if (args.boolean('help')) {
		console.log(usage);
		return;
	}
	const line = 'Usage: yoal registry scan <org>/<name>[:<tag>|@sha256:…] [--json]';
	rejectExtraPositionals(args, 1, line);
	const ref = requirePositional(args, 0, `the image.\n\n${line}`);
	const at = ref.indexOf('@');
	const colon = ref.lastIndexOf(':');
	const [repository, reference] = at > 0 ? [ref.slice(0, at), ref.slice(at + 1)] : colon > ref.lastIndexOf('/') ? [ref.slice(0, colon), ref.slice(colon + 1)] : [ref, 'latest'];
	const client = await authenticatedClient();
	const { report, raw } = await client.registryScan(repository!, reference!);
	if (args.boolean('json')) {
		printJson(raw);
		return;
	}
	const summary = report.summary as Record<string, number | string> | null;
	console.log(
		summary
			? `${report.image}: ${summary.Count ?? 0} vulnerabilities (critical ${summary.CriticalCount ?? 0}, high ${summary.HighCount ?? 0}, medium ${summary.MediumCount ?? 0}, low ${summary.LowCount ?? 0})`
			: `${report.image}: not scanned yet.`,
	);
	if (report.cves.length) console.log(renderTable(['CVE', 'SEVERITY', 'TITLE'], report.cves.map((cve) => [cve.Id, cve.Severity, cve.Title.slice(0, 80)])));
}

async function trust(argv: string[]): Promise<void> {
	const [action, ...rest] = argv;
	const args = parseArgs(rest, { ...confirmFlags, ref: { type: 'string' }, 'pull-only': { type: 'boolean' } });
	if (args.boolean('help') || action === '-h' || action === '--help') {
		console.log(`Usage: yoal registry trust [list]
       yoal registry trust add <github-owner>/<repo> <org>/<name|*> [--ref refs/heads/main] [--pull-only]
       yoal registry trust rm <id> [--yes]

In the workflow (permissions: id-token: write), get a token for audience <registry host> and log in
with username github-oidc and the token as password (docker/login-action works).`);
		return;
	}
	const client = await authenticatedClient();
	if (!action || action === 'list' || action === 'ls') {
		const { trusts, raw } = await client.listRegistryTrusts();
		if (args.boolean('json')) return printJson(raw);
		if (trusts.length === 0) return console.log('No trusts. Add one with `yoal registry trust add <owner>/<repo> <org>/<name>`.');
		console.log(renderTable(['ID', 'GITHUB REPOSITORY', 'REF', 'REGISTRY REPOSITORY', 'ACCESS'], trusts.map((t) => [t.id, t.githubRepository, t.ref ?? 'any', t.repository, t.push ? 'push' : 'pull'])));
		return;
	}
	if (action === 'add') {
		const line = 'Usage: yoal registry trust add <github-owner>/<repo> <org>/<name|*> [--ref <glob>] [--pull-only]';
		rejectExtraPositionals(args, 2, line);
		const githubRepository = requirePositional(args, 0, `the GitHub repository.\n\n${line}`);
		const repository = requirePositional(args, 1, `the registry repository.\n\n${line}`);
		const ref = args.string('ref');
		const { trust: created, raw } = await client.createRegistryTrust({ githubRepository, repository, push: !args.boolean('pull-only'), ...(ref ? { ref } : {}) });
		if (args.boolean('json')) return printJson(raw);
		console.log(`Trusted ${githubRepository}${ref ? ` at ${ref}` : ''} → ${repository} (${created.id}).`);
		return;
	}
	if (action === 'rm' || action === 'remove' || action === 'delete') {
		const id = requirePositional(args, 0, 'the trust id.');
		const ok = await confirmOrRefuse(`Remove trust ${id}? Workflows using it stop pushing. [y/N] `, { yes: args.boolean('yes'), refusal: 'Not removed. Pass --yes to remove without asking.' });
		if (!ok) return;
		await client.deleteRegistryTrust(id);
		console.log(`Removed ${id}.`);
		return;
	}
	throw new UsageError(`Unknown registry trust command "${action}".`);
}
