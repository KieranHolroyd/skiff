import * as z from 'zod';
import { parseImageReference } from './registry.ts';

/** Kept local so `workload.ts` can import this module without a cycle. */
const envNameSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Env names are letters, digits and underscores, not starting with a digit.');
const secretNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Z][A-Z0-9_]*$/, 'Secret names are UPPER_SNAKE_CASE.');

/**
 * Level 4: a project whose deployment is a `docker-compose.yml`.
 *
 * Compose is a *grouping* runtime, not a new isolation primitive. Every service still becomes a
 * rootless Quadlet container rendered by the privileged helper; services in one stack share a
 * private Podman network and resolve each other by service name. One or more services are exposed
 * through Caddy, each on its own host or the project's own host (docs/COMPOSE.md).
 *
 * The subset is deliberately small and strict. A compose file is a deployment input, not an
 * escape hatch: `build`, `privileged`, host networking, capabilities, devices, bind mounts and
 * compose extension scripts are rejected with a path, never silently ignored.
 */

/** Compose service names become container aliases and DNS names, so keep them DNS-safe. */
export const composeServiceNameSchema = z
	.string()
	.min(1)
	.max(40)
	.regex(
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
		'Service names are 1–40 lowercase letters, digits and hyphens; start and end with a letter or digit.',
	);

/** A named volume inside the stack. It is a helper-owned directory, never a host bind mount. */
export const composeVolumeSchema = z.strictObject({
	name: z
		.string()
		.min(1)
		.max(63)
		.regex(/^[a-z0-9][a-z0-9_-]*$/, 'Volume names are lowercase letters, digits, underscores and hyphens.'),
	/** Absolute mount path inside the container. */
	mountPath: z.string().startsWith('/').max(200),
	readOnly: z.boolean().default(false),
});
export type ComposeVolume = z.infer<typeof composeVolumeSchema>;

export const composeServiceSchema = z
	.strictObject({
		name: composeServiceNameSchema,
		/** Pinned image reference (`name:tag` or `name@sha256:…`). */
		image: z.string().trim().min(1).max(512),
		/** Overrides the image command; argv, never a shell string. */
		command: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
		/** Plain variables for this service only. */
		env: z.record(envNameSchema, z.string().max(16_384)).default({}),
		/** Secret references resolved at activation and delivered to this service only. */
		secrets: z.array(secretNameSchema).max(64).default([]),
		/**
		 * Container ports the service listens on. A port is only reachable from Caddy when a route
		 * names it; the others are private to the stack's network.
		 */
		ports: z.array(z.number().int().min(1).max(65_535)).max(16).default([]),
		/** Start after these services. Cycles are rejected. */
		dependsOn: z.array(composeServiceNameSchema).max(20).default([]),
		volumes: z.array(composeVolumeSchema).max(20).default([]),
		memoryMb: z.number().int().min(32).max(8192).default(256),
		cpus: z.number().positive().max(8).default(1),
	})
	.superRefine((service, ctx) => {
		if (!parseImageReference(service.image))
			ctx.addIssue({ code: 'custom', path: ['image'], message: `"${service.image}" is not a valid image reference.` });
		if (new Set(service.ports).size !== service.ports.length)
			ctx.addIssue({ code: 'custom', path: ['ports'], message: 'Each port is listed once.' });
		if (new Set(service.secrets).size !== service.secrets.length)
			ctx.addIssue({ code: 'custom', path: ['secrets'], message: 'Each secret is referenced once.' });
		for (const name of service.secrets)
			if (name in service.env)
				ctx.addIssue({ code: 'custom', path: ['env', name], message: `${name} is also a secret reference.` });
		if (new Set(service.volumes.map((volume) => volume.mountPath)).size !== service.volumes.length)
			ctx.addIssue({ code: 'custom', path: ['volumes'], message: 'Each mount path is used once.' });
	});
export type ComposeService = z.infer<typeof composeServiceSchema>;

/**
 * One exposed service. `host` is the public hostname that reaches this service; omitted means the
 * stack derives `<service>-<slug>.<contentDomain>`. `hostPort` is assigned by Yoal at deploy time
 * (the loopback port Caddy dials) and is never accepted from an input.
 */
export const composeRouteSchema = z.strictObject({
	service: composeServiceNameSchema,
	/** Container port inside the service. */
	port: z.number().int().min(1).max(65_535),
	host: z
		.string()
		.trim()
		.min(4)
		.max(253)
		.transform((value) => value.toLowerCase().replace(/\.$/, ''))
		.refine(
			(value) => /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(value),
			'Use a hostname like app.example.com (no scheme, port or path).',
		)
		.optional(),
	healthPath: z.string().startsWith('/').max(512).default('/'),
	/** The service the project's own host serves. Defaults to the first route. */
	primary: z.boolean().default(false),
	/** Loopback port Caddy dials; set by Yoal, never by an input. */
	hostPort: z.number().int().min(1).max(65_535).optional(),
});
export type ComposeRoute = z.infer<typeof composeRouteSchema>;

export const composeSpecSchema = z
	.strictObject({
		/** Top-level named volumes; services reference them by name. */
		volumes: z
			.array(
				z.strictObject({
					name: z
						.string()
						.min(1)
						.max(63)
						.regex(/^[a-z0-9][a-z0-9_-]*$/, 'Volume names are lowercase letters, digits, underscores and hyphens.'),
				}),
			)
			.max(20)
			.default([]),
		services: z.array(composeServiceSchema).min(1).max(20),
		routes: z.array(composeRouteSchema).max(20).default([]),
	})
	.superRefine((spec, ctx) => {
		const names = spec.services.map((service) => service.name);
		if (new Set(names).size !== names.length)
			ctx.addIssue({ code: 'custom', path: ['services'], message: 'Each service name is used once.' });
		const declared = new Set(names);
		const declaredVolumes = new Set(spec.volumes.map((volume) => volume.name));

		for (const [index, service] of spec.services.entries()) {
			for (const dependency of service.dependsOn) {
				if (dependency === service.name)
					ctx.addIssue({
						code: 'custom',
						path: ['services', index, 'dependsOn'],
						message: 'A service cannot depend on itself.',
					});
				else if (!declared.has(dependency))
					ctx.addIssue({
						code: 'custom',
						path: ['services', index, 'dependsOn'],
						message: `Unknown service "${dependency}".`,
					});
			}
			for (const [volumeIndex, volume] of service.volumes.entries())
				if (!declaredVolumes.has(volume.name))
					ctx.addIssue({
						code: 'custom',
						path: ['services', index, 'volumes', volumeIndex, 'name'],
						message: `Volume "${volume.name}" is not declared at the top level.`,
					});
		}

		// A dependency cycle cannot be ordered; catch it before the helper renders units.
		const byName = new Map(spec.services.map((service) => [service.name, service]));
		const visiting = new Set<string>();
		const done = new Set<string>();
		const visit = (name: string): boolean => {
			if (done.has(name)) return true;
			if (visiting.has(name)) return false;
			visiting.add(name);
			for (const dependency of byName.get(name)?.dependsOn ?? []) if (!visit(dependency)) return false;
			visiting.delete(name);
			done.add(name);
			return true;
		};
		if (!spec.services.every((service) => visit(service.name)))
			ctx.addIssue({ code: 'custom', path: ['services'], message: '`dependsOn` contains a cycle.' });

		const primaries = spec.routes.filter((route) => route.primary);
		if (primaries.length > 1)
			ctx.addIssue({ code: 'custom', path: ['routes'], message: 'Only one route can be primary.' });
		if (spec.routes.length > 0 && primaries.length === 0) spec.routes[0]!.primary = true;

		// One service port may serve several hosts, but a host may only appear once: two services
		// claiming one hostname would make Caddy's route order decide the winner.
		const hosts = new Set<string>();
		for (const [index, route] of spec.routes.entries()) {
			const service = byName.get(route.service);
			if (!service)
				ctx.addIssue({
					code: 'custom',
					path: ['routes', index, 'service'],
					message: `Unknown service "${route.service}".`,
				});
			else if (!service.ports.includes(route.port))
				ctx.addIssue({
					code: 'custom',
					path: ['routes', index, 'port'],
					message: `Service "${route.service}" does not declare port ${route.port}.`,
				});
			if (route.host) {
				const host = route.host.toLowerCase();
				if (hosts.has(host))
					ctx.addIssue({ code: 'custom', path: ['routes', index, 'host'], message: `Host "${route.host}" is routed twice.` });
				hosts.add(host);
			}
		}
	});
export type ComposeSpec = z.infer<typeof composeSpecSchema>;
export type ComposeSpecInput = z.input<typeof composeSpecSchema>;

/** `POST /projects/:slug/deploy-compose`: a YAML/JSON compose document, never applied implicitly. */
export const composeDeploySchema = z.strictObject({
	/** The compose file text (YAML or JSON) or an already-parsed document. */
	document: z.union([z.string().min(1).max(512 * 1024), z.record(z.string(), z.unknown())]),
	promote: z.boolean().optional(),
	message: z.string().max(500).optional(),
	environment: z.string().min(1).max(40).optional(),
});
export type ComposeDeployInput = z.input<typeof composeDeploySchema>;

/** What `parse-compose` returns: the strict stack plus every warning/unsupported entry. */
export const composeParseResultSchema = z.strictObject({
	spec: composeSpecSchema,
	warnings: z.array(z.strictObject({ path: z.string(), message: z.string().max(1000) })).max(500).default([]),
	unsupported: z
		.array(z.strictObject({ path: z.string(), reason: z.string().max(1000) }))
		.max(500)
		.default([]),
});
export type ComposeParseResult = z.infer<typeof composeParseResultSchema>;
