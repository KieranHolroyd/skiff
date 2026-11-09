import {
	composeServiceNameSchema,
	composeSpecSchema,
	type ComposeRoute,
	type ComposeService,
	type ComposeSpec,
} from '@skiff/contracts';
import { ValidationError } from './errors.ts';

/**
 * `docker-compose.yml` → a strict ComposeSpec (docs/COMPOSE.md).
 *
 * The translator is intentionally narrow. Every key it understands is mapped to a field the
 * helper can render without a shell; every key it does not understand is reported at its exact
 * path, and any `unsupported` entry makes a deploy refuse rather than run a partial stack.
 *
 * Supported subset:
 *   - `services.<name>.image`, `command` (argv or a simple shell-form string), `environment`
 *     (map or `KEY=value` list), `depends_on`, `ports` (container port only), named `volumes`,
 *     `deploy.resources.limits.{memory,cpus}`, `x-skiff.healthPath`
 *   - top-level named `volumes`
 *   - `x-skiff.routes[]` for public routing (`service`, `port`, optional `host`, `healthPath`,
 *     `primary`)
 *
 * Deliberately unsupported: `build`, bind mounts, host networking, `privileged`, capabilities,
 * devices, `env_file`, `secrets`/`configs`, `extends`, profiles, and any top-level network that is
 * not the default one. These are security boundaries, not missing conveniences.
 */

const SUPPORTED_TOP_LEVEL = new Set(['version', 'name', 'services', 'volumes', 'networks', 'x-skiff']);
const IGNORED_SERVICE_KEYS = new Set([
	'container_name',
	'hostname',
	'restart',
	'init',
	'read_only',
	'stdin_open',
	'tty',
	'stop_grace_period',
	'logging',
	'labels',
	'shm_size',
	'sysctls',
	'ulimits',
	'extra_hosts',
	'working_dir',
	'healthcheck',
]);
const UNSUPPORTED_SERVICE_KEYS = new Set([
	'build',
	'develop',
	'cap_add',
	'cap_drop',
	'devices',
	'network_mode',
	'pid',
	'ipc',
	'networks',
	'links',
	'external_links',
	'extends',
	'profiles',
	'env_file',
	'secrets',
	'configs',
	'privileged',
	'security_opt',
	'userns_mode',
	'group_add',
	'platform',
	'entrypoint',
	'deploy',
]);

interface Warning {
	path: string;
	message: string;
}
interface Unsupported {
	path: string;
	reason: string;
}

export interface ParsedCompose {
	spec: ComposeSpec;
	warnings: Warning[];
	unsupported: Unsupported[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDocument(document: string | Record<string, unknown>): Record<string, unknown> {
	if (typeof document !== 'string') {
		if (!isRecord(document)) throw new ValidationError('The compose document must be a mapping.');
		return document;
	}
	const text = document.trim();
	if (!text) throw new ValidationError('The compose file is empty.');
	if (text.length > 512 * 1024) throw new ValidationError('A compose file is at most 512 KB.');
	try {
		const parsed = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : Bun.YAML.parse(text);
		if (!isRecord(parsed)) throw new Error('the top level must be a mapping');
		return parsed;
	} catch (error) {
		throw new ValidationError(
			`The compose file is not valid YAML or JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** A simple shell-form command split with quotes, without expansion or operators. */
export function splitCommand(value: string): string[] {
	const argv: string[] = [];
	let current = '';
	let quote: '"' | "'" | null = null;
	let has = false;
	for (const char of value) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			has = true;
			continue;
		}
		if (char === ' ' || char === '\t') {
			if (has) argv.push(current);
			current = '';
			has = false;
			continue;
		}
		current += char;
		has = true;
	}
	if (quote) throw new ValidationError('A command string has an unterminated quote.');
	if (has) argv.push(current);
	if (argv.length === 0) throw new ValidationError('A command string is empty.');
	return argv;
}

function parseCommand(value: unknown, path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return splitCommand(value);
	if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string'))
		return value as string[];
	throw new ValidationError(`${path} must be a string or an array of strings.`);
}

function parseEnvironment(value: unknown, path: string, warnings: Warning[]): Record<string, string> {
	if (value === undefined) return {};
	const env: Record<string, string> = {};
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			if (typeof entry !== 'string') throw new ValidationError(`${path}[${index}] must be a string.`);
			const equals = entry.indexOf('=');
			if (equals <= 0) {
				warnings.push({ path: `${path}[${index}]`, message: `${entry} has no value here; set it in the project environment instead.` });
				continue;
			}
			env[entry.slice(0, equals)] = entry.slice(equals + 1);
		}
		for (const [name, entry] of Object.entries(env))
			if (entry.includes('${'))
				warnings.push({
					path: `${path}.${name}`,
					message: 'Compose interpolation is not performed; set the resolved value in the project environment or a secret.',
				});
		return env;
	}
	if (!isRecord(value)) throw new ValidationError(`${path} must be a mapping or a list.`);
	for (const [name, raw] of Object.entries(value)) {
		if (raw === null || raw === undefined) {
			warnings.push({ path: `${path}.${name}`, message: 'A null value is ignored; set it in the project environment instead.' });
			continue;
		}
		const text = String(raw);
		env[name] = text;
		if (text.includes('${'))
			warnings.push({
				path: `${path}.${name}`,
				message: 'Compose interpolation is not performed; set the resolved value in the project environment or a secret.',
			});
	}
	return env;
}

/** `8080:80`, `127.0.0.1:8080:80`, `80`, `80/udp`, ranges: only the bare container port is safe. */
function parsePort(entry: unknown, path: string, unsupported: Unsupported[]): number | null {
	if (typeof entry === 'number' && Number.isInteger(entry)) return entry;
	if (typeof entry !== 'string') {
		unsupported.push({ path, reason: 'Ports must be container ports (`"80"`) or mappings.' });
		return null;
	}
	const value = entry.trim();
	if (value.includes('/') && !value.endsWith('/tcp')) {
		unsupported.push({ path, reason: 'Only TCP ports are supported.' });
		return null;
	}
	const withoutProtocol = value.endsWith('/tcp') ? value.slice(0, -4) : value;
	const parts = withoutProtocol.split(':');
	if (parts.length > 2) {
		unsupported.push({ path, reason: 'Host IP and host-port mapping are assigned by Skiff; use x-skiff.routes for public ports.' });
		return null;
	}
	const container = parts.at(-1)!;
	if (!/^\d+$/.test(container)) {
		unsupported.push({ path, reason: 'Port ranges are not supported.' });
		return null;
	}
	const port = Number(container);
	if (port < 1 || port > 65_535) {
		unsupported.push({ path, reason: 'Ports must be between 1 and 65535.' });
		return null;
	}
	return port;
}

function parseDependsOn(value: unknown, path: string): string[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) {
		if (!value.every((entry) => typeof entry === 'string'))
			throw new ValidationError(`${path} must be a list of service names.`);
		return value as string[];
	}
	if (isRecord(value)) return Object.keys(value);
	throw new ValidationError(`${path} must be a list or a mapping.`);
}

function parseBytes(value: unknown, path: string): number {
	const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|ki|m|mb|mi|g|gb|gi)?$/i.exec(text);
	if (!match) throw new ValidationError(`${path} must be a size like "512M" or "1g".`);
	const amount = Number(match[1]);
	const unit = (match[2] ?? 'b').toLowerCase();
	const factor = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? 1024 ** 2 : unit.startsWith('k') ? 1024 : 1;
	return Math.max(1, Math.round((amount * factor) / (1024 * 1024)));
}

function parseCpus(value: unknown, path: string): number {
	const cpus = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
	if (!Number.isFinite(cpus) || cpus <= 0) throw new ValidationError(`${path} must be a positive number.`);
	return cpus;
}

/** Top-level `name:/path[:ro]`; a bind mount, anonymous volume or device is unsupported. */
function parseVolume(
	entry: unknown,
	path: string,
	declared: Set<string>,
	unsupported: Unsupported[],
): { name: string; mountPath: string; readOnly: boolean } | null {
	if (typeof entry !== 'string') {
		unsupported.push({ path, reason: 'Volumes must be `"name:/path"`.' });
		return null;
	}
	const parts = entry.split(':');
	if (parts.length < 2) {
		unsupported.push({ path, reason: 'Anonymous volumes are not supported; name it under top-level volumes.' });
		return null;
	}
	const [source, target, mode] = parts;
	if (!source || !target) {
		unsupported.push({ path, reason: 'Volumes must be `"name:/path"`.' });
		return null;
	}
	if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) {
		unsupported.push({ path, reason: 'Bind mounts from the host are not supported; use a named volume.' });
		return null;
	}
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(source)) {
		unsupported.push({ path, reason: `"${source}" is not a valid volume name.` });
		return null;
	}
	if (!target.startsWith('/')) {
		unsupported.push({ path, reason: 'The container mount path must be absolute.' });
		return null;
	}
	if (mode && mode !== 'ro' && mode !== 'rw') {
		unsupported.push({ path, reason: `Volume mode "${mode}" is not supported (use ro or rw).` });
		return null;
	}
	declared.add(source);
	return { name: source, mountPath: target, readOnly: mode === 'ro' };
}

function parseRoutes(value: unknown, path: string): Array<Partial<ComposeRoute> & { service: string; port?: number }> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ValidationError(`${path} must be a list.`);
	return value.map((entry, index) => {
		if (!isRecord(entry)) throw new ValidationError(`${path}[${index}] must be a mapping.`);
		const service = entry.service;
		if (typeof service !== 'string' || !composeServiceNameSchema.safeParse(service).success)
			throw new ValidationError(`${path}[${index}].service must name a service.`);
		const route: Partial<ComposeRoute> & { service: string; port?: number } = { service };
		if (entry.port !== undefined) {
			if (!Number.isInteger(entry.port) || (entry.port as number) < 1 || (entry.port as number) > 65_535)
				throw new ValidationError(`${path}[${index}].port must be a container port.`);
			route.port = entry.port as number;
		}
		if (entry.host !== undefined) {
			if (typeof entry.host !== 'string') throw new ValidationError(`${path}[${index}].host must be a hostname.`);
			route.host = entry.host;
		}
		if (entry.healthPath !== undefined) {
			if (typeof entry.healthPath !== 'string' || !entry.healthPath.startsWith('/'))
				throw new ValidationError(`${path}[${index}].healthPath must start with "/".`);
			route.healthPath = entry.healthPath;
		}
		if (entry.primary !== undefined) {
			if (typeof entry.primary !== 'boolean') throw new ValidationError(`${path}[${index}].primary must be a boolean.`);
			route.primary = entry.primary;
		}
		return route;
	});
}

export function parseComposeDocument(document: string | Record<string, unknown>): ParsedCompose {
	const root = parseDocument(document);
	const warnings: Warning[] = [];
	const unsupported: Unsupported[] = [];

	for (const key of Object.keys(root))
		if (!SUPPORTED_TOP_LEVEL.has(key) && !key.startsWith('x-'))
			unsupported.push({ path: key, reason: 'This top-level compose key is not supported.' });
	if (root.networks !== undefined)
		warnings.push({
			path: 'networks',
			message: 'Custom compose networks are ignored; every service joins the project workload network.',
		});

	const rawServices = root.services;
	if (!isRecord(rawServices) || Object.keys(rawServices).length === 0)
		throw new ValidationError('A compose file needs at least one service under `services`.');

	// Named volumes: top-level declarations plus any implicit ones a service references.
	const topVolumes = new Set<string>();
	if (root.volumes !== undefined) {
		if (!isRecord(root.volumes)) throw new ValidationError('`volumes` must be a mapping.');
		for (const name of Object.keys(root.volumes)) topVolumes.add(name);
	}

	const services: ComposeService[] = [];
	const serviceHealth = new Map<string, string>();
	const order: string[] = [];
	for (const [name, raw] of Object.entries(rawServices)) {
		if (!composeServiceNameSchema.safeParse(name).success)
			throw new ValidationError(`Service name "${name}" is not valid: use 1–40 lowercase letters, digits and hyphens.`);
		if (!isRecord(raw)) throw new ValidationError(`services.${name} must be a mapping.`);
		order.push(name);

		for (const key of Object.keys(raw)) {
			if (['image', 'command', 'environment', 'depends_on', 'volumes', 'ports', 'expose', 'deploy', 'x-skiff'].includes(key))
				continue;
			if (UNSUPPORTED_SERVICE_KEYS.has(key)) {
				if (key === 'privileged' && raw[key] !== true) continue;
				if (key === 'deploy') continue;
				unsupported.push({ path: `services.${name}.${key}`, reason: `\`${key}\` is not supported.` });
				continue;
			}
			if (IGNORED_SERVICE_KEYS.has(key)) {
				warnings.push({ path: `services.${name}.${key}`, message: `\`${key}\` is managed by Skiff and ignored.` });
				continue;
			}
			if (key.startsWith('x-')) continue;
			unsupported.push({ path: `services.${name}.${key}`, reason: 'Unknown service key.' });
		}

		if (raw.image === undefined) {
			// `build:` already has its own unsupported entry above; do not also complain about the
			// missing image, which would send the author looking for the wrong fix.
			if (raw.build === undefined)
				unsupported.push({ path: `services.${name}.image`, reason: 'Every service needs a prebuilt `image`; `build` is not supported.' });
			continue;
		}
		if (typeof raw.image !== 'string' || !raw.image.trim())
			throw new ValidationError(`services.${name}.image must be an image reference.`);

		const env = parseEnvironment(raw.environment, `services.${name}.environment`, warnings);
		const ports: number[] = [];
		for (const field of ['ports', 'expose'] as const) {
			const rawPorts = raw[field];
			if (rawPorts === undefined) continue;
			if (!Array.isArray(rawPorts)) throw new ValidationError(`services.${name}.${field} must be a list.`);
			for (const [index, entry] of rawPorts.entries()) {
				if (typeof entry === 'string' && entry.split(':').length === 2)
					warnings.push({
						path: `services.${name}.${field}[${index}]`,
						message: `The host port in "${entry}" is ignored; Skiff assigns the public port from x-skiff.routes.`,
					});
				const port = parsePort(entry, `services.${name}.${field}[${index}]`, unsupported);
				if (port !== null && !ports.includes(port)) ports.push(port);
			}
		}
		const volumes: ComposeService['volumes'] = [];
		if (raw.volumes !== undefined) {
			if (!Array.isArray(raw.volumes)) throw new ValidationError(`services.${name}.volumes must be a list.`);
			for (const [index, entry] of raw.volumes.entries()) {
				const volume = parseVolume(entry, `services.${name}.volumes[${index}]`, topVolumes, unsupported);
				if (volume) volumes.push(volume);
			}
		}

		let memoryMb = 256;
		let cpus = 1;
		if (raw.deploy !== undefined) {
			if (!isRecord(raw.deploy)) throw new ValidationError(`services.${name}.deploy must be a mapping.`);
			for (const key of Object.keys(raw.deploy))
				if (key !== 'resources' && key !== 'replicas')
					unsupported.push({ path: `services.${name}.deploy.${key}`, reason: 'Only deploy.resources.limits are supported.' });
			if (raw.deploy.replicas !== undefined && raw.deploy.replicas !== 1)
				unsupported.push({ path: `services.${name}.deploy.replicas`, reason: 'Scale a compose service to one copy; use replicas on a single-image project instead.' });
			const resources = raw.deploy.resources;
			if (resources !== undefined) {
				if (!isRecord(resources)) throw new ValidationError(`services.${name}.deploy.resources must be a mapping.`);
				const limits = resources.limits;
				if (limits !== undefined) {
					if (!isRecord(limits)) throw new ValidationError(`services.${name}.deploy.resources.limits must be a mapping.`);
					if (limits.memory !== undefined) memoryMb = parseBytes(limits.memory, `services.${name}.deploy.resources.limits.memory`);
					if (limits.cpus !== undefined) cpus = parseCpus(limits.cpus, `services.${name}.deploy.resources.limits.cpus`);
				}
			}
		}

		// A service-level x-skiff block may name the health path for its route.
		let healthPath: string | undefined;
		if (raw['x-skiff'] !== undefined) {
			if (!isRecord(raw['x-skiff'])) throw new ValidationError(`services.${name}.x-skiff must be a mapping.`);
			const block = raw['x-skiff'];
			for (const key of Object.keys(block))
				if (key !== 'healthPath') unsupported.push({ path: `services.${name}.x-skiff.${key}`, reason: 'Only healthPath is supported here.' });
			if (block.healthPath !== undefined) {
				if (typeof block.healthPath !== 'string' || !block.healthPath.startsWith('/'))
					throw new ValidationError(`services.${name}.x-skiff.healthPath must start with "/".`);
				healthPath = block.healthPath;
			}
		}
		if (healthPath) serviceHealth.set(name, healthPath);

		const command = parseCommand(raw.command, `services.${name}.command`);
		services.push({
			name,
			image: raw.image.trim(),
			...(command ? { command } : {}),
			env,
			secrets: [],
			ports,
			dependsOn: parseDependsOn(raw.depends_on, `services.${name}.depends_on`),
			volumes,
			memoryMb,
			cpus,
		});
	}

	const xskiff = root['x-skiff'];
	let routeInputs: Array<Partial<ComposeRoute> & { service: string; port?: number }> = [];
	if (xskiff !== undefined) {
		if (!isRecord(xskiff)) throw new ValidationError('`x-skiff` must be a mapping.');
		for (const key of Object.keys(xskiff))
			if (key !== 'routes') unsupported.push({ path: `x-skiff.${key}`, reason: 'Only x-skiff.routes is supported.' });
		routeInputs = parseRoutes(xskiff.routes, 'x-skiff.routes');
	}

	// No explicit routes: expose the first service that declares a port, and warn about the rest.
	if (routeInputs.length === 0) {
		const first = services.find((service) => service.ports.length > 0);
		if (first) {
			routeInputs = [{ service: first.name, port: first.ports[0]!, primary: true }];
			warnings.push({
				path: 'x-skiff.routes',
				message: `No routes declared; exposing "${first.name}" on port ${first.ports[0]}. Add x-skiff.routes to choose services and hostnames.`,
			});
		}
	}

	const byName = new Map(services.map((service) => [service.name, service]));
	const routes: ComposeRoute[] = routeInputs.map((route, index) => {
		const service = byName.get(route.service);
		const port = route.port ?? service?.ports[0];
		if (!service) throw new ValidationError(`x-skiff.routes[${index}].service names unknown service "${route.service}".`);
		if (port === undefined) throw new ValidationError(`x-skiff.routes[${index}] needs a port (service "${route.service}" declares none).`);
		if (!service.ports.includes(port))
			throw new ValidationError(`Service "${route.service}" does not declare container port ${port}.`);
		return {
			service: route.service,
			port,
			...(route.host ? { host: route.host } : {}),
			healthPath: route.healthPath ?? serviceHealth.get(route.service) ?? '/',
			primary: route.primary ?? index === 0,
		};
	});

	// Services that reference a volume but do not declare it at the top level: accept implicitly.
	for (const service of services)
		for (const volume of service.volumes)
			if (!topVolumes.has(volume.name)) {
				topVolumes.add(volume.name);
				warnings.push({ path: `services.${service.name}.volumes`, message: `Volume "${volume.name}" is implicitly created; declare it under top-level volumes.` });
			}

	let spec: ComposeSpec;
	try {
		spec = composeSpecSchema.parse({
			volumes: [...topVolumes].map((name) => ({ name })),
			services,
			routes,
		});
	} catch (error) {
		const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
		if (!issues) throw error;
		throw new ValidationError(
			`The compose stack is invalid:\n${issues
				.slice(0, 8)
				.map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`)
				.join('\n')}`,
		);
	}
	return { spec, warnings, unsupported };
}

/** Throw when a parsed file needs something the runtime cannot render. */
export function assertComposeSupported(parsed: ParsedCompose): ComposeSpec {
	if (parsed.unsupported.length === 0) return parsed.spec;
	const lines = parsed.unsupported.slice(0, 8).map((entry) => `${entry.path}: ${entry.reason}`);
	const more = parsed.unsupported.length > 8 ? `\n…and ${parsed.unsupported.length - 8} more.` : '';
	throw new ValidationError(`This compose file uses features Skiff does not support:\n${lines.join('\n')}${more}`);
}

/** Parse and refuse unsupported input in one step (the deploy path). */
export function prepareCompose(document: string | Record<string, unknown>): ParsedCompose {
	return parseComposeDocument(document);
}
