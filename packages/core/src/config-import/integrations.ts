import { eventTypesBySource } from '@skiff/contracts';
import { arr, live, obj, pick, str, strings, type ImportContext, type Item } from './context.ts';

/**
 * Integrations (docs/OPERATIONS.md §14): pipelines, alert rules, event rules, log drains, email
 * domains and backup targets. Anything that needs a credential the export cannot hold (registry
 * passwords, forge tokens, S3 keys, drain headers, pipeline secrets) is listed under `manual`.
 */

const ALERT_FIELDS = [
	'name',
	'description',
	'enabled',
	'severity',
	'query',
	'variables',
	'condition',
	'windowSeconds',
	'intervalSeconds',
	'forSeconds',
	'keepFiringSeconds',
	'noData',
	'repeatMinutes',
	'notifyOnResolve',
	'channels',
	'emails',
	'runbook',
] as const;

/** Old id → this instance's id, for ids embedded in alert queries (project_id, database_id, …). */
function idRewrites(ctx: ImportContext): [string, string][] {
	const out: [string, string][] = [];
	for (const project of ctx.projects()) {
		const row = typeof project.slug === 'string' ? ctx.projectRow(project.slug) : undefined;
		if (row && typeof project.id === 'string' && project.id !== row.id) out.push([project.id, row.id]);
	}
	const named = [
		['databases', (name: string) => ctx.maybe(() => ctx.core.databases.requireRow(ctx.principal, name))?.id],
		['storage', (name: string) => ctx.maybe(() => ctx.core.storage.requireRow(ctx.principal, name))?.id],
		['brokers', (name: string) => ctx.maybe(() => ctx.core.brokers.requireRow(ctx.principal, name))?.id],
	] as const;
	for (const [section, lookup] of named)
		for (const item of ctx.items(section)) {
			const name = str(item.name);
			const id = name ? lookup(name) : undefined;
			if (id && typeof item.id === 'string' && item.id !== id) out.push([item.id, id]);
		}
	return out;
}

function rewriteIds<T>(value: T, rewrites: [string, string][]): T {
	if (!rewrites.length || value === undefined || value === null) return value;
	let text = JSON.stringify(value);
	for (const [from, to] of rewrites) text = text.split(JSON.stringify(from).slice(1, -1)).join(to);
	return JSON.parse(text) as T;
}

function oldAlertRuleName(ctx: ImportContext, id: unknown): string | null {
	return str(ctx.items('alertRules').find((rule) => rule.id === id)?.name);
}

function alertRuleId(ctx: ImportContext, name: string): string | null {
	const rules = ctx.maybe(() => ctx.core.alerts.listRules(ctx.principal)) ?? [];
	return rules.find((rule) => rule.name.toLowerCase() === name.toLowerCase())?.id ?? null;
}

export function planIntegrations(ctx: ImportContext): void {
	const { plan, core, principal } = ctx;

	if (ctx.wants('pipelines'))
		for (const repo of ctx.items('pipelines')) {
			const name = str(repo.name);
			if (!name) continue;
			const key = `pipelines.${name}`;
			const step = { key, section: 'pipelines', kind: 'pipeline repository', name };
			const existing = ctx.maybe(() => core.pipelines.getRepository(principal, name));
			if (existing) plan.exists(step);
			else
				plan.create(step, () => {
					const created = core.pipelines.createRepository(principal, {
						...pick(repo, ['name', 'cloneUrl', 'provider', 'defaultBranch', 'defaultImage', 'minIsolation']),
					} as never);
					if (repo.enabled === false) core.pipelines.updateRepository(principal, name, { enabled: false } as never);
					return created;
				});
			if (!existing) {
				if (repo.hasWebhookSecret) plan.manualStep('pipelines', name, 'Set the webhook secret again and point the forge webhook at the new URL');
				if (repo.hasStatusToken) plan.manualStep('pipelines', name, 'Set the commit-status token again');
				if (repo.githubAppInstallationId) plan.manualStep('pipelines', name, 'Install the GitHub App on this repository again (Settings → GitHub)');
			}
			const variables = existing ? (ctx.maybe(() => core.pipelines.listVariables(principal, name)) ?? []) : [];
			for (const variable of arr(repo.variables)) {
				const varName = str(variable.name);
				if (!varName) continue;
				const varStep = { key: `${key}.variables.${varName}`, section: 'pipelines', kind: 'pipeline variable', name: `${name}/${varName}` };
				if (variables.some((row) => row.name === varName)) plan.exists(varStep);
				else plan.create({ ...varStep, dependsOn: [key] }, () => core.pipelines.setVariable(principal, name, varName, String(variable.value ?? '')));
			}
			const environments = existing ? (ctx.maybe(() => core.pipelines.listEnvironments(principal, name)) ?? []) : [];
			for (const env of arr(repo.environments)) {
				const envName = str(env.name);
				if (!envName) continue;
				const envStep = { key: `${key}.environments.${envName}`, section: 'pipelines', kind: 'pipeline environment', name: `${name}/${envName}` };
				if (environments.some((row) => row.name === envName)) plan.exists(envStep);
				else
					plan.create({ ...envStep, dependsOn: [key] }, () =>
						core.pipelines.setEnvironment(principal, name, envName, { allowedRefs: strings(env.allowedRefs), requireApproval: env.requireApproval === true }),
					);
			}
			for (const secret of arr(repo.secrets)) {
				const secretName = str(secret.name);
				if (!secretName) continue;
				const scope = str(secret.environment);
				plan.manualStep('pipelines', `${name}/${secretName}`, `Set the pipeline secret again: skif secret set ${name} ${secretName}${scope ? ` --environment ${scope}` : ''}`);
			}
			const links = existing ? (ctx.maybe(() => core.pipelines.listProjectLinks(principal, name)) ?? []) : [];
			for (const link of arr(repo.projectLinks)) {
				const slug = str(link.projectSlug);
				if (!slug) continue;
				const linkStep = { key: `${key}.links.${slug}`, section: 'pipelines', kind: 'pipeline link', name: `${name} → ${slug}` };
				if (links.some((row) => row.projectSlug === slug)) plan.exists(linkStep);
				else if (!ctx.projectRow(slug) && !plan.available(`projects.${slug}`)) plan.skip(linkStep, `project ${slug} is not here or in this import`);
				else
					plan.create({ ...linkStep, dependsOn: [key, `projects.${slug}`] }, () =>
						core.pipelines.linkProject(principal, name, slug, { environment: str(link.environment) }),
					);
			}
		}

	if (ctx.wants('alertRules'))
		for (const rule of ctx.items('alertRules')) {
			const name = str(rule.name);
			if (!name) continue;
			const step = { key: `alertRules.${name}`, section: 'alertRules', kind: 'alert rule', name };
			if (alertRuleId(ctx, name)) {
				plan.exists(step);
				continue;
			}
			plan.create(step, () => {
				const rewrites = idRewrites(ctx);
				const input = pick(rule, ALERT_FIELDS, ['description', 'runbook']);
				return core.alerts.createRule(principal, { ...input, query: rewriteIds(input.query, rewrites), variables: rewriteIds(input.variables, rewrites), source: null });
			});
		}

	if (ctx.wants('eventRules'))
		for (const rule of ctx.items('eventRules')) {
			const source = str(rule.source);
			const broker = str(rule.broker);
			const queue = str(rule.queue);
			if (!source || !broker || !queue) continue;
			const filter = obj(rule.filter);
			const label = `${source} → ${broker}/${queue}`;
			const key = `eventRules.${source}.${broker}.${queue}.${JSON.stringify(filter)}`;
			const step = { key, section: 'eventRules', kind: 'event rule', name: label };
			if (broker === '(deleted broker)') {
				plan.skip(step, 'its broker was deleted');
				continue;
			}
			const alertName = filter.alertRule ? oldAlertRuleName(ctx, filter.alertRule) : null;
			const sameFilter = (row: { source: string; broker: string; queue: string; filter: unknown }) => {
				const rowFilter = { ...obj(row.filter) };
				const wanted = { ...filter };
				if (alertName) {
					wanted.alertRule = alertRuleId(ctx, alertName);
				}
				return row.source === source && row.broker === broker && row.queue === queue && JSON.stringify(rowFilter) === JSON.stringify(wanted);
			};
			if (ctx.maybe(() => core.events.list(principal))?.some(sameFilter)) {
				plan.exists(step);
				continue;
			}
			const all = (eventTypesBySource as Record<string, readonly string[]>)[source] ?? [];
			const events = strings(rule.events);
			const deps = [`brokers.${broker}`];
			if (alertName) deps.push(`alertRules.${alertName}`);
			if (str(filter.storage)) deps.push(`storage.${String(filter.storage)}`);
			if (str(filter.storage) && str(filter.bucket)) deps.push(`storage.${String(filter.storage)}.buckets.${String(filter.bucket)}`);
			if (str(filter.project)) deps.push(`projects.${String(filter.project)}`);
			if (str(filter.database)) deps.push(`databases.${String(filter.database)}`);
			if (str(filter.repository)) deps.push(`pipelines.${String(filter.repository)}`);
			if (str(filter.pool)) deps.push(`userPools.${String(filter.pool)}`);
			plan.create({ ...step, dependsOn: deps }, () => {
				const resolvedFilter: Item = { ...filter };
				if (alertName) {
					const id = alertRuleId(ctx, alertName);
					if (!id) throw new Error(`alert rule ${alertName} is missing`);
					resolvedFilter.alertRule = id;
				}
				for (const field of Object.keys(resolvedFilter)) if (resolvedFilter[field] === null) delete resolvedFilter[field];
				return core.events.create(principal, {
					source,
					events: events.length === all.length && all.every((event) => events.includes(event)) ? [] : events,
					...resolvedFilter,
					broker,
					queue,
					...(str(rule.description) ? { description: String(rule.description) } : {}),
					enabled: rule.enabled !== false,
				} as never);
			});
		}

	if (ctx.wants('logDrains')) {
		const existing = ctx.maybe(() => core.logDrains.list(principal)) ?? [];
		for (const drain of ctx.items('logDrains')) {
			const name = str(drain.name);
			const url = str(drain.url);
			if (!name || !url) continue;
			const step = { key: `logDrains.${name}`, section: 'logDrains', kind: 'log drain', name };
			if (existing.some((row) => row.name === name)) {
				plan.exists(step);
				continue;
			}
			if (url.includes('=***')) {
				plan.skip(step, 'its URL carries a credential in the query string, which is never exported');
				plan.manualStep('logDrains', name, `Create it again with the full URL (${url})`);
				continue;
			}
			const headers = strings(drain.headerNames);
			const project = str(drain.project);
			plan.create({ ...step, dependsOn: project ? [`projects.${project}`] : [] }, () =>
				core.logDrains.create(principal, {
					...pick(drain, ['name', 'kind', 'url', 'sources', 'minLevel', 'allowPrivateNetwork']),
					...(drain.kind === 'webhook' && drain.format ? { format: drain.format } : {}),
					...(project ? { project } : {}),
					// Header values are write-only; a drain that needs them stays off until they are set.
					enabled: headers.length ? false : drain.enabled !== false,
				} as never),
			);
			if (headers.length) plan.manualStep('logDrains', name, `Set the header${headers.length > 1 ? 's' : ''} ${headers.join(', ')} again, then enable it`);
			if (drain.signed) plan.manualStep('logDrains', name, 'Has a new signing secret: update the receiver');
		}
	}

	if (ctx.wants('email'))
		for (const domain of arr(obj(ctx.doc.email).domains)) {
			const name = str(domain.name);
			if (!name) continue;
			const step = { key: `email.domains.${name}`, section: 'email', kind: 'email domain', name };
			if (ctx.maybe(() => core.email.getDomain(principal, name))) {
				plan.exists(step);
				continue;
			}
			plan.create(step, () => core.email.createDomain(principal, { name, sending: domain.sending !== false, receiving: false, autoDns: true }));
			plan.manualStep('email', name, 'Publish its new DNS records (the DKIM key changed); see Email → Domains');
		}

	if (ctx.wants('backupTargets')) {
		const existing = ctx.maybe(() => core.backupTargets.list(principal)) ?? [];
		for (const target of ctx.items('backupTargets')) {
			const name = str(target.name);
			if (!name || target.orgId === null) continue; // the platform default is not the org's
			const step = { key: `backupTargets.${name}`, section: 'backupTargets', kind: 'backup target', name };
			if (existing.some((row) => row.orgId !== null && row.name === name)) {
				plan.exists(step);
				continue;
			}
			if (target.kind === 'local') {
				plan.create(step, () => core.backupTargets.create(principal, { name, kind: 'local', path: String(target.path), writeOnly: target.writeOnly === true } as never));
				continue;
			}
			plan.skip(step, 'S3 targets need their access keys, which are never exported');
			plan.manualStep('backupTargets', name, `Add it again with its keys (bucket ${String(target.bucket)}, region ${String(target.region)}${target.endpoint ? `, endpoint ${String(target.endpoint)}` : ''})`);
		}
	}

	if (ctx.wants('registryCredentials'))
		for (const cred of ctx.items('registryCredentials'))
			plan.manualStep('registryCredentials', String(cred.name ?? cred.registry), `Add the login for ${String(cred.registry)} as ${String(cred.username)} again (passwords are never exported)`);

	if (ctx.wants('forgeConnections'))
		for (const forge of ctx.items('forgeConnections'))
			plan.manualStep('forgeConnections', String(forge.name ?? forge.baseUrl), `Connect ${String(forge.kind)} at ${String(forge.baseUrl)} again with a token (Settings → Git providers)`);

	if (ctx.wants('shares') && live(ctx.items('shares')).length)
		plan.manualStep('shares', `${live(ctx.items('shares')).length} share(s)`, 'Network shares are platform settings: a platform admin adds them again (Settings → Shares)');
}
