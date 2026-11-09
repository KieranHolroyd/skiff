import {
	appVolumeCreateSchema,
	brokerCreateSchema,
	bucketCreateSchema,
	databaseCreateSchema,
	environmentCreateSchema,
	jobCreateSchema,
	projectCreateSchema,
	storageCreateSchema,
} from '@yoal/contracts';
import { arr, live, obj, pick, str, type ImportContext, type Item } from './context.ts';

/**
 * Projects and the services they use (docs/OPERATIONS.md §14): secrets, projects, environments,
 * databases, storage and buckets, brokers, then workload settings, jobs, volumes, domains and
 * attachments, in the order the services need them.
 */

const ACCESS = new Set(['public', 'platform', 'password', 'access']);

/** Passwords and policy assignments cannot be created with the project; they follow later. */
function initialAccess(mode: unknown): 'public' | 'platform' {
	return mode === 'public' ? 'public' : 'platform';
}

const projectKey = (slug: string) => `projects.${slug}`;
const secretKey = (project: string | null, name: string) => (project ? `projects.${project}.secrets.${name}` : `secrets.${name}`);

/** `org` secrets go first; project secrets after their projects (a step only waits on earlier steps). */
export function planSecrets(ctx: ImportContext, which: 'org' | 'projects'): void {
	const { plan, core, principal } = ctx;
	const add = (project: string | null, secret: Item) => {
		const name = str(secret.name);
		if (!name) return;
		const key = secretKey(project, name);
		const label = project ? `${project}/${name}` : name;
		const row = project ? ctx.projectRow(project) : null;
		if (project && row && core.secrets.latest(principal.orgId, row.id, name)) return plan.exists({ key, section: 'secrets', kind: 'secret', name: label });
		if (!project && core.secrets.latest(principal.orgId, null, name)) return plan.exists({ key, section: 'secrets', kind: 'secret', name: label });
		const value = ctx.options.secrets[label];
		if (value === undefined) {
			plan.skip({ key, section: 'secrets', kind: 'secret', name: label }, 'no value supplied (--secrets)');
			plan.manualStep('secrets', label, `Set the value: yoal secret… or pass ${label}=… in --secrets and import again`);
			return;
		}
		const type = secret.type === 'env' ? 'env' : 'secret';
		plan.create({ key, section: 'secrets', kind: 'secret', name: label, dependsOn: project ? [projectKey(project)] : [] }, () =>
			core.secrets.set(principal, { name, value, type, projectId: project ? ctx.requireProject(project).id : null }),
		);
	};
	if (which === 'org') {
		if (ctx.wants('secrets')) for (const secret of ctx.items('secrets')) add(null, secret);
		return;
	}
	if (ctx.wants('projects'))
		for (const project of ctx.projects())
			if (ctx.wantsProject(String(project.slug))) for (const secret of arr(project.secrets)) add(String(project.slug), secret);
}

export function planProjects(ctx: ImportContext): void {
	if (!ctx.wants('projects')) return;
	const { plan, core, principal } = ctx;
	for (const project of ctx.projects()) {
		const slug = String(project.slug);
		if (!ctx.wantsProject(slug)) continue;
		const key = projectKey(slug);
		const step = { key, section: 'projects', kind: 'project', name: slug };
		const existing = ctx.projectRow(slug, true);
		if (existing?.deletedAt) plan.skip(step, 'a project with this slug is in the trash here; restore or purge it first');
		else if (existing) plan.exists(step);
		else {
			const spec = obj(project.placementSpec);
			// Node, volume and `near` ids belong to the old instance.
			const placementSpec = pick(spec, ['zone', 'roles', 'labels', 'volumeClass', 'spread']);
			const input = projectCreateSchema.parse({
				slug,
				name: str(project.name) ?? slug,
				runtime: project.runtime,
				placement: str(project.placement) ?? 'edge',
				...(Object.keys(placementSpec).length ? { placementSpec } : {}),
				productionAccess: initialAccess(project.productionAccess),
				previewAccess: initialAccess(project.previewAccess),
			});
			plan.create(step, () => core.projects.create(principal, input));
		}
		for (const [scope, field, passwordSet] of [
			['production', 'productionAccess', 'productionPasswordSet'],
			['previews', 'previewAccess', 'previewPasswordSet'],
		] as const) {
			if (project[field] === 'password' && !existing)
				plan.manualStep('projects', `${slug} ${scope}`, `Was password-protected${project[passwordSet] ? '' : ' (no password set)'}; imported as platform-only. Set a new password in the project's access settings`);
		}
		if (project.runtime !== 'static' && !existing)
			plan.manualStep('projects', slug, project.runtime === 'function' ? 'Deploy the function bundle again (yoal deploy); its code and bindings are not in the export' : 'Deploy the app (no deployments are imported)');
		else if (project.runtime === 'static' && !existing) plan.manualStep('projects', slug, 'Deploy the site (no deployments are imported)');

		for (const env of arr(project.environments)) {
			const envSlug = str(env.slug);
			if (!envSlug || env.isProduction || envSlug === 'production') continue;
			const envKey = `${key}.environments.${envSlug}`;
			const envStep = { key: envKey, section: 'projects', kind: 'environment', name: `${slug}/${envSlug}` };
			if (existing && ctx.environmentRow(slug, envSlug)) {
				plan.exists(envStep);
				continue;
			}
			const access = typeof env.access === 'string' && ACCESS.has(env.access) ? initialAccess(env.access) : undefined;
			const input = environmentCreateSchema.parse({ name: str(env.name) ?? envSlug, slug: envSlug, ...(access ? { access } : {}) });
			plan.create({ ...envStep, dependsOn: [key] }, () => core.environments.create(principal, ctx.requireProject(slug), input));
			if (env.access === 'password')
				plan.manualStep('projects', `${slug}/${envSlug}`, 'Was password-protected; imported as platform-only. Set a new password');
		}
	}
}

/** Services attached by an exported project, for placement next to it (D56). */
function attachedBy(ctx: ImportContext, type: 'databases' | 'storage' | 'brokers', name: string): string[] {
	const field = type === 'databases' ? 'databaseName' : type === 'storage' ? 'storageName' : 'brokerName';
	return ctx
		.projects()
		.filter((project) => arr(obj(project.attachments)[type]).some((attachment) => attachment[field] === name))
		.map((project) => String(project.slug));
}

/**
 * Where to place a new service so that the attach steps later do not trip the same-node rule:
 * next to a service the same project already uses here, else the project's placement.
 */
function placementFor(ctx: ImportContext, type: 'databases' | 'storage' | 'brokers', name: string): string | undefined {
	const [project] = attachedBy(ctx, type, name);
	if (!project) return undefined;
	const exported = ctx.projects().find((item) => item.slug === project);
	const attachments = obj(exported?.attachments);
	const siblings: (string | undefined)[] = [
		...arr(attachments.databases).map((a) => {
			const sibling = str(a.databaseName);
			return sibling && !(type === 'databases' && sibling === name) ? ctx.maybe(() => ctx.core.databases.requireRow(ctx.principal, sibling))?.nodeId ?? undefined : undefined;
		}),
		...arr(attachments.storage).map((a) => {
			const sibling = str(a.storageName);
			if (!sibling || (type === 'storage' && sibling === name)) return undefined;
			const row = ctx.maybe(() => ctx.core.storage.requireRow(ctx.principal, sibling));
			return row && !row.public ? (row.nodeId ?? undefined) : undefined;
		}),
		...arr(attachments.brokers).map((a) => {
			const sibling = str(a.brokerName);
			return sibling && !(type === 'brokers' && sibling === name) ? ctx.maybe(() => ctx.core.brokers.requireRow(ctx.principal, sibling))?.nodeId ?? undefined : undefined;
		}),
	];
	const node = siblings.find((id) => typeof id === 'string' && id.length > 0);
	if (node) return node;
	const placement = str(exported?.placement);
	return placement === 'edge' || placement === 'auto' ? placement : undefined;
}

export function planServices(ctx: ImportContext): void {
	const { plan, core, principal } = ctx;
	const wantedBy = (type: 'databases' | 'storage' | 'brokers', name: string) => {
		// With a project filter, only services those projects use come along.
		if (ctx.options.projects === null) return true;
		return attachedBy(ctx, type, name).some((slug) => ctx.wantsProject(slug));
	};

	if (ctx.wants('databases'))
		for (const db of live(ctx.items('databases'))) {
			const name = str(db.name);
			if (!name || !wantedBy('databases', name)) continue;
			const step = { key: `databases.${name}`, section: 'databases', kind: 'database', name };
			const row = ctx.maybe(() => core.databases.requireRow(principal, name, { includeDeleted: true }));
			if (row?.deletedAt) plan.skip(step, 'a database with this name is in the trash here');
			else if (row) plan.exists(step);
			else
				plan.create(step, () =>
					core.databases.create(
						principal,
						databaseCreateSchema.parse({
							...pick(db, ['name', 'engine', 'version', 'variant', 'memoryMb', 'cpus', 'storageMb', 'extensions']),
							pooler: obj(db.pooler).enabled === true,
							...(placementFor(ctx, 'databases', name) ? { placement: placementFor(ctx, 'databases', name) } : {}),
						}),
					),
				);
			if (!row) {
				plan.manualStep('databases', name, 'Starts empty: restore its data from your own dump or backup');
				const backup = obj(db.backup);
				if (backup.enabled === true)
					plan.manualStep('databases', name, `Turn scheduled backups back on (was ${str(backup.schedule) ?? 'scheduled'}, ${String(backup.retentionDays ?? '?')} days) once a backup target exists`);
			}
		}

	if (ctx.wants('storage'))
		for (const storage of live(ctx.items('storage'))) {
			const name = str(storage.name);
			if (!name || !wantedBy('storage', name)) continue;
			const key = `storage.${name}`;
			const step = { key, section: 'storage', kind: 'storage', name };
			const row = ctx.maybe(() => core.storage.requireRow(principal, name, { includeDeleted: true }));
			if (row?.deletedAt) plan.skip(step, 'storage with this name is in the trash here');
			else if (row) plan.exists(step);
			else {
				const isPublic = storage.public === true;
				plan.create(step, () => {
					const placement = isPublic ? undefined : placementFor(ctx, 'storage', name);
					return core.storage.create(
						principal,
						storageCreateSchema.parse({
							...pick(storage, ['name', 'engine', 'version', 'memoryMb', 'cpus', 'storageMb']),
							public: isPublic,
							...(placement ? { placement } : {}),
						}),
					);
				});
				plan.manualStep('storage', name, 'Buckets start empty: copy objects across (e.g. with rclone) from your own copy');
			}
			for (const bucket of arr(storage.buckets)) {
				const bucketName = str(bucket.name);
				if (!bucketName) continue;
				const bucketStep = { key: `${key}.buckets.${bucketName}`, section: 'storage', kind: 'bucket', name: `${name}/${bucketName}` };
				const existingBucket = row ? ctx.maybe(() => core.storage.getBucketConfig(principal, name, bucketName)) : undefined;
				if (existingBucket) {
					plan.exists(bucketStep);
					continue;
				}
				const input = bucketCreateSchema.parse({
					...pick(bucket, ['name', 'access', 'versioning', 'lifecycle', 'cors', 'objectLock'], ['objectLock']),
					quotaBytes: typeof bucket.quotaBytes === 'number' ? bucket.quotaBytes : null,
				});
				plan.create({ ...bucketStep, dependsOn: [key] }, () => core.storage.createBucket(principal, name, input));
			}
		}

	if (ctx.wants('brokers'))
		for (const broker of live(ctx.items('brokers'))) {
			const name = str(broker.name);
			if (!name || !wantedBy('brokers', name)) continue;
			const step = { key: `brokers.${name}`, section: 'brokers', kind: 'broker', name };
			const row = ctx.maybe(() => core.brokers.requireRow(principal, name, { includeDeleted: true }));
			if (row?.deletedAt) plan.skip(step, 'a broker with this name is in the trash here');
			else if (row) plan.exists(step);
			else
				plan.create(step, () => {
					const placement = placementFor(ctx, 'brokers', name);
					return core.brokers.create(
						principal,
						brokerCreateSchema.parse({
							...pick(broker, ['name', 'engine', 'version', 'memoryMb', 'cpus', 'storageMb']),
							...(placement ? { placement } : {}),
						}),
					);
				});
		}
}

/** Workload settings, jobs, volumes, domains and attachments: after projects, secrets and services. */
export function planProjectSettings(ctx: ImportContext): void {
	if (!ctx.wants('projects')) return;
	const { plan, core, principal } = ctx;
	for (const project of ctx.projects()) {
		const slug = String(project.slug);
		if (!ctx.wantsProject(slug)) continue;
		const key = projectKey(slug);
		const row = ctx.projectRow(slug);

		// Workload settings (process and container; a function's spec comes from its bundle).
		const workload = obj(project.workload);
		if (Object.keys(workload).length && (project.runtime === 'process' || project.runtime === 'container')) {
			const step = { key: `${key}.workload`, section: 'projects', kind: 'workload', name: slug };
			if (row && core.workloads.projectSpec(row)) plan.exists(step, 'workload settings already set; left as they are');
			else {
				const refs = arr(workload.secrets).map((ref) => ({ ...pick(ref, ['name', 'delivery', 'path', 'mode']) })) as Item[];
				const missing = refs
					.map((ref) => String(ref.name))
					.filter((name) => {
						if (plan.available(secretKey(slug, name)) || plan.available(secretKey(null, name))) return false;
						return !(row && core.secrets.resolve(principal.orgId, row.id, name)) && !core.secrets.resolve(principal.orgId, null, name);
					});
				if (missing.length) plan.skip(step, `needs secret${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; set ${missing.length > 1 ? 'them' : 'it'} and import again`);
				else {
					// Image digests pin the old registry's content; secret versions restart here.
					const { imageDigest: _digest, ...rest } = workload;
					const spec = { ...rest, secrets: refs };
					// Wait only for secrets this import creates; existing ones already resolve.
					const creates = (k: string) => plan.get(k)?.action === 'create';
					const secretDeps = refs.flatMap((ref) => [secretKey(slug, String(ref.name)), secretKey(null, String(ref.name))]).filter(creates);
					plan.create(
						{ ...step, dependsOn: [key, ...secretDeps] },
						() => core.workloads.setSpec(principal, ctx.requireProject(slug), spec as never),
					);
				}
			}
		}

		for (const job of arr(project.jobs)) {
			const name = str(job.name);
			if (!name) continue;
			const step = { key: `${key}.jobs.${name}`, section: 'projects', kind: 'job', name: `${slug}/${name}` };
			if (row && ctx.maybe(() => core.jobs.get(principal, row, name))) {
				plan.exists(step);
				continue;
			}
			const input = jobCreateSchema.parse(pick(job, ['name', 'command', 'schedule', 'timeoutSeconds', 'concurrency', 'maxRetries', 'enabled'], ['schedule']));
			plan.create({ ...step, dependsOn: [key] }, () => core.jobs.create(principal, ctx.requireProject(slug), input));
		}

		for (const volume of arr(project.volumes)) {
			const name = str(volume.name);
			if (!name) continue;
			const step = { key: `${key}.volumes.${name}`, section: 'projects', kind: 'volume', name: `${slug}/${name}` };
			if (row && ctx.maybe(() => core.appVolumes.get(principal, row, name))) {
				plan.exists(step);
				continue;
			}
			const input = appVolumeCreateSchema.parse(pick(volume, ['name', 'sizeMb', 'singleWriter']));
			plan.create({ ...step, dependsOn: [key] }, () => core.appVolumes.create(principal, ctx.requireProject(slug), input));
			for (const attachment of arr(volume.attachments))
				plan.manualStep('projects', `${slug}/${name}`, `After the first deploy, attach it: yoal volume attach ${slug} ${name} --mount ${String(attachment.mountPath)}${attachment.readOnly ? ' --read-only' : ''}${attachment.environment && attachment.environment !== 'production' ? ` --environment ${String(attachment.environment)}` : ''}. It starts empty`);
		}

		for (const domain of arr(project.domains)) {
			const hostname = str(domain.hostname);
			if (!hostname) continue;
			const step = { key: `${key}.domains.${hostname}`, section: 'projects', kind: 'domain', name: hostname };
			const taken = ctx.domainTaken(hostname);
			if (taken && row && taken.projectId === row.id) plan.exists(step);
			else if (taken) plan.skip(step, 'this hostname is already attached to another project here');
			else {
				plan.create({ ...step, dependsOn: [key] }, () => core.domains.create(principal, { project: slug, hostname, redirectWww: domain.redirectWww === true }));
				plan.manualStep('projects', hostname, 'Point its DNS at the new server and add the new verification TXT record (the token changed)');
			}
		}

		const attachments = obj(project.attachments);
		for (const attachment of arr(attachments.databases)) {
			const name = str(attachment.databaseName);
			if (!name) continue;
			const step = { key: `attachments.${slug}.database.${name}`, section: 'projects', kind: 'attachment', name: `${slug} → database ${name}` };
			if (row && core.databases.attachments(principal, row).some((a) => a.databaseName === name)) {
				plan.exists(step);
				continue;
			}
			if (attachment.credentialRole) plan.warnings.push(`${slug} used database ${name} with the named credential "${String(attachment.credentialRole)}"; it is attached with the default credential. Create the credential and re-attach if needed.`);
			const envPrefix = str(attachment.envPrefix);
			plan.create({ ...step, dependsOn: [key, `databases.${name}`] }, () =>
				core.databases.attach(principal, ctx.requireProject(slug), { database: name, ...(envPrefix ? { envPrefix } : {}) } as never),
			);
		}
		for (const attachment of arr(attachments.storage)) {
			const name = str(attachment.storageName);
			if (!name) continue;
			const step = { key: `attachments.${slug}.storage.${name}`, section: 'projects', kind: 'attachment', name: `${slug} → storage ${name}` };
			if (row && core.storage.attachments(principal, row).some((a) => a.storageName === name)) {
				plan.exists(step);
				continue;
			}
			const grants = arr(attachment.grants).map((grant) => pick(grant, ['bucket', 'mode']));
			const envPrefix = str(attachment.envPrefix);
			plan.create(
				{ ...step, dependsOn: [key, `storage.${name}`, ...grants.map((grant) => `storage.${name}.buckets.${String(grant.bucket)}`)] },
				() => core.storage.attach(principal, ctx.requireProject(slug), { storage: name, grants, ...(envPrefix ? { envPrefix } : {}) } as never),
			);
		}
		for (const attachment of arr(attachments.brokers)) {
			const name = str(attachment.brokerName);
			if (!name) continue;
			const step = { key: `attachments.${slug}.broker.${name}`, section: 'projects', kind: 'attachment', name: `${slug} → broker ${name}` };
			if (row && core.brokers.attachments(principal, row).some((a) => a.brokerName === name)) {
				plan.exists(step);
				continue;
			}
			const envPrefix = str(attachment.envPrefix);
			plan.create({ ...step, dependsOn: [key, `brokers.${name}`] }, () =>
				core.brokers.attach(principal, ctx.requireProject(slug), { broker: name, ...(envPrefix ? { envPrefix } : {}) } as never),
			);
		}
	}
}
