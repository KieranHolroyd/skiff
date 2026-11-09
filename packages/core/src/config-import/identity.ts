import { arr, obj, pick, str, strings, type ImportContext, type Item } from './context.ts';

/**
 * Access and identity (docs/OPERATIONS.md §14): members (reported), custom roles, groups and their
 * members, service accounts, federation trusts, user pools and clients, Yoal Access policies and
 * their assignments, guardrails, bindings and the org auth policy.
 *
 * People cannot be imported: a user exists here only once they sign up. Users are matched by email
 * (`iam.members` in the export); a grant for someone who is not a member here yet is skipped and
 * the invitation is listed under `manual`.
 */

const SYSTEM_PREFIX = 'system:';

/** Old user id → this instance's user id, by email. */
function userId(ctx: ImportContext, oldId: unknown): string | null {
	return ctx.userIdByEmail(ctx.emailByUserId(oldId));
}

function oldGroupName(ctx: ImportContext, id: unknown): string | null {
	return str(arr(ctx.iam().groups).find((group) => group.id === id)?.name);
}

function oldServiceAccountName(ctx: ImportContext, id: unknown): string | null {
	return str(ctx.items('serviceAccounts').find((sa) => sa.id === id)?.name);
}

function oldPoolName(ctx: ImportContext, id: unknown): string | null {
	return str(ctx.items('userPools').find((pool) => pool.id === id)?.name);
}

function oldPolicy(ctx: ImportContext, id: unknown): Item | undefined {
	return ctx.items('accessPolicies').find((policy) => policy.id === id);
}

/** A principal from the export → this instance, or a reason it cannot be found. */
function principalRef(ctx: ImportContext, type: unknown, id: unknown): { id: string } | { problem: string } {
	if (type === 'user') {
		const email = ctx.emailByUserId(id);
		const found = ctx.userIdByEmail(email);
		return found ? { id: found } : { problem: `${email ?? 'a user'} is not a member here yet` };
	}
	if (type === 'group') {
		const name = oldGroupName(ctx, id);
		const found = name ? ctx.groupId(name) : null;
		return found ? { id: found } : { problem: `group ${name ?? String(id)} is not here` };
	}
	if (type === 'serviceAccount') {
		const name = oldServiceAccountName(ctx, id);
		const found = name ? ctx.serviceAccountId(name) : null;
		return found ? { id: found } : { problem: `service account ${name ?? String(id)} is not here` };
	}
	return { problem: `${String(type)} principals are not imported` };
}

/** A stable name for a binding, for keys and messages. */
function principalLabel(ctx: ImportContext, type: unknown, id: unknown): string {
	if (type === 'user') return ctx.emailByUserId(id) ?? String(id);
	if (type === 'group') return `group ${oldGroupName(ctx, id) ?? String(id)}`;
	if (type === 'serviceAccount') return `sa ${oldServiceAccountName(ctx, id) ?? String(id)}`;
	return String(id);
}

function scopeLabel(ctx: ImportContext, scope: unknown): string {
	const ref = obj(scope);
	if (!ref.type || ref.type === 'org') return 'org';
	if (ref.type === 'project') return `project ${ctx.projectSlugById(ref.id) ?? String(ref.id)}`;
	if (ref.type === 'environment') {
		const env = ctx.environmentById(ref.id);
		return `environment ${env ? `${env.project}/${env.environment}` : String(ref.id)}`;
	}
	return `${String(ref.type)} ${String(ref.id ?? '')}`.trim();
}

export function planIdentityEarly(ctx: ImportContext): void {
	const { plan, core, principal } = ctx;
	const iam = ctx.iam();

	if (ctx.wants('iam')) {
		for (const member of arr(iam.members)) {
			const email = str(member.email);
			if (!email || ctx.userIdByEmail(email)) continue;
			plan.manualStep('members', email, `Invite them as ${String(member.role ?? 'member')} (Settings → Members); their grants import once they have joined`);
		}

		for (const role of arr(iam.roles)) {
			const name = str(role.name);
			if (!name || role.builtIn) continue;
			const step = { key: `iam.roles.${name}`, section: 'iam', kind: 'role', name };
			if (ctx.customRoleId(name)) plan.exists(step);
			else
				plan.create(step, () =>
					core.iam.createRole(principal, { name, description: str(role.description) ?? undefined, permissions: strings(role.permissions) }),
				);
		}

		for (const group of arr(iam.groups)) {
			const name = str(group.name);
			if (!name) continue;
			const key = `iam.groups.${name}`;
			const step = { key, section: 'iam', kind: 'group', name };
			if (group.source === 'scim') {
				plan.skip(step, 'provisioned by SCIM; set up SCIM here and it is created again');
				continue;
			}
			if (ctx.groupId(name)) plan.exists(step);
			else plan.create(step, () => core.iam.createGroup(principal, { name, description: str(group.description) ?? undefined }));
			for (const oldMember of strings(group.memberUserIds)) {
				const email = ctx.emailByUserId(oldMember);
				const memberStep = { key: `${key}.members.${email ?? oldMember}`, section: 'iam', kind: 'group member', name: `${name} ← ${email ?? oldMember}` };
				const newId = userId(ctx, oldMember);
				if (!newId) {
					plan.skip(memberStep, `${email ?? 'this user'} is not a member here yet`);
					continue;
				}
				const groupHere = ctx.groupId(name);
				if (groupHere && ctx.groupHasMember(groupHere, newId)) {
					plan.exists(memberStep);
					continue;
				}
				plan.create({ ...memberStep, dependsOn: [key] }, () => {
					const groupId = ctx.groupId(name);
					if (!groupId) throw new Error(`group ${name} is missing`);
					core.iam.addGroupMember(principal, groupId, newId);
				});
			}
		}
	}

	if (ctx.wants('serviceAccounts'))
		for (const sa of ctx.items('serviceAccounts')) {
			const name = str(sa.name);
			if (!name) continue;
			const key = `serviceAccounts.${name}`;
			const step = { key, section: 'serviceAccounts', kind: 'service account', name };
			if (ctx.serviceAccountId(name)) {
				plan.exists(step);
				continue;
			}
			const ownerGroup = sa.ownerGroupId ? oldGroupName(ctx, sa.ownerGroupId) : null;
			plan.create({ ...step, dependsOn: ownerGroup ? [`iam.groups.${ownerGroup}`] : [] }, () => {
				const created = core.serviceAccounts.create(principal, {
					name,
					...(str(sa.description) ? { description: String(sa.description) } : {}),
					...(ownerGroup ? { ownerGroupId: ctx.groupId(ownerGroup) } : {}),
				});
				if (sa.disabled === true) core.serviceAccounts.update(principal, created.id, { disabled: true });
				return created;
			});
		}

	if (ctx.wants('accessKeys'))
		for (const key of ctx.items('accessKeys')) {
			if (key.revokedAt) continue;
			const owner = key.principalType === 'serviceAccount' ? `service account ${oldServiceAccountName(ctx, key.principalId) ?? '?'}` : 'its user';
			plan.manualStep('accessKeys', String(key.name ?? key.id), `Issue a new key for ${owner} and update whatever used it (keys are never exported)`);
		}

	if (ctx.wants('federationTrusts'))
		for (const trust of ctx.items('federationTrusts')) {
			const saName = oldServiceAccountName(ctx, trust.serviceAccountId);
			const issuer = str(trust.issuer);
			if (!saName || !issuer) continue;
			const audiences = strings(trust.audiences).sort();
			const subject = str(trust.subjectPattern);
			const name = `${saName} ← ${issuer}${subject ? ` (${subject})` : ''}`;
			const step = { key: `federationTrusts.${saName}.${issuer}.${subject ?? '*'}.${audiences.join(',')}`, section: 'federationTrusts', kind: 'federation trust', name };
			const saId = ctx.serviceAccountId(saName);
			const same = saId
				? ctx.maybe(() => core.federation.list(principal))?.some(
						(row) => row.serviceAccountId === saId && row.issuer === issuer.replace(/\/+$/, '') && (row.subjectPattern ?? null) === subject && [...row.audiences].sort().join(',') === audiences.join(','),
					)
				: false;
			if (same) {
				plan.exists(step);
				continue;
			}
			plan.create({ ...step, dependsOn: [`serviceAccounts.${saName}`] }, () => {
				const serviceAccountId = ctx.serviceAccountId(saName);
				if (!serviceAccountId) throw new Error(`service account ${saName} is missing`);
				return core.federation.create(principal, {
					serviceAccountId,
					issuer,
					audiences,
					...pick(trust, ['subjectPattern', 'claimConditions', 'maxTtlSeconds', 'restriction']),
				} as never);
			});
		}

	if (ctx.wants('userPools'))
		for (const pool of ctx.items('userPools')) {
			const name = str(pool.name);
			if (!name) continue;
			const key = `userPools.${name}`;
			const step = { key, section: 'userPools', kind: 'user pool', name };
			const existing = ctx.poolId(name);
			if (existing) plan.exists(step);
			else {
				plan.create(step, async () => {
					const created = await core.userPools.create(
						principal,
						pick(pool, ['name', 'description', 'engine', 'signupMode', 'theme', 'requireEmailVerification', 'mfaRequired']) as never,
					);
					if (pool.disabled === true) core.userPools.update(principal, created.id, { disabled: true } as never);
					return created;
				});
				plan.manualStep('userPools', name, 'New issuer and signing key: update every app that trusts this pool. Pool users are not exported; they sign up again or are invited');
			}
			for (const client of arr(pool.clients)) {
				const clientName = str(client.name);
				if (!clientName) continue;
				const clientStep = { key: `${key}.clients.${clientName}`, section: 'userPools', kind: 'pool client', name: `${name}/${clientName}` };
				if (existing && ctx.maybe(() => core.userPools.listClients(principal, existing))?.some((row) => row.name === clientName)) {
					plan.exists(clientStep);
					continue;
				}
				plan.create({ ...clientStep, dependsOn: [key] }, () => {
					const poolId = ctx.poolId(name);
					if (!poolId) throw new Error(`user pool ${name} is missing`);
					return core.userPools.createClient(principal, poolId, {
						name: clientName,
						redirectUris: strings(client.redirectUris),
						public: client.public === true,
					});
				});
				plan.manualStep('userPools', `${name}/${clientName}`, 'Gets a new client id (and secret, shown in Settings → User pools): update the app that uses it');
			}
			const groups = existing ? (ctx.maybe(() => core.userPools.listGroups(principal, existing)) ?? []) : [];
			for (const group of arr(pool.groups)) {
				const groupName = str(group.name);
				if (!groupName) continue;
				const groupStep = { key: `${key}.groups.${groupName}`, section: 'userPools', kind: 'pool group', name: `${name}/${groupName}` };
				if (groups.some((row) => row.name === groupName)) {
					plan.exists(groupStep);
					continue;
				}
				plan.create({ ...groupStep, dependsOn: [key] }, () => {
					const poolId = ctx.poolId(name);
					if (!poolId) throw new Error(`user pool ${name} is missing`);
					return core.userPools.createGroup(principal, poolId, groupName);
				});
			}
		}
}

/** Access policies first need their projects and pools; guardrails and bindings need everything. */
export function planIdentityLate(ctx: ImportContext): void {
	const { plan, core, principal } = ctx;

	if (ctx.wants('accessPolicies')) {
		for (const policy of ctx.items('accessPolicies')) {
			const name = str(policy.name);
			if (!name) continue;
			const scope = obj(policy.scope);
			const where = scopeLabel(ctx, scope);
			const key = `accessPolicies.${where}.${name}`;
			const step = { key, section: 'accessPolicies', kind: 'access policy', name: `${name} (${where})` };
			const resolved = ctx.resolveScope(scope);
			if ('scope' in resolved && findPolicy(ctx, name, resolved.scope)) {
				plan.exists(step);
				continue;
			}
			const deps: string[] = [];
			if (scope.type === 'project' || scope.type === 'environment') {
				const slug = scope.type === 'project' ? ctx.projectSlugById(scope.id) : ctx.environmentById(scope.id)?.project;
				if (slug) deps.push(`projects.${slug}`);
				if (scope.type === 'environment') {
					const env = ctx.environmentById(scope.id);
					if (env) deps.push(`projects.${env.project}.environments.${env.environment}`);
				}
			}
			const rules = arr(policy.rules);
			for (const rule of rules) {
				const matcher = obj(rule.matcher);
				if (matcher.type === 'orgGroup') {
					const group = oldGroupName(ctx, matcher.groupId);
					if (group) deps.push(`iam.groups.${group}`);
				}
				if (matcher.type === 'userPool') {
					const pool = oldPoolName(ctx, matcher.poolId);
					if (pool) deps.push(`userPools.${pool}`);
				}
				if (matcher.type === 'ssoProvider')
					plan.warnings.push(`Access policy ${name} matches an SSO provider; SSO providers are not exported, so set it up again and fix the rule.`);
			}
			plan.create({ ...step, dependsOn: deps }, () => {
				const target = ctx.resolveScope(scope);
				if ('problem' in target) throw new Error(target.problem);
				return core.accessPolicies.create(principal, {
					name,
					...(str(policy.description) ? { description: String(policy.description) } : {}),
					scope: target.scope,
					enabled: policy.enabled !== false,
					rules: rules.map((rule, index) => ({ ...remapRule(ctx, rule), idx: index })),
				} as never);
			});
		}

		// Assignments: production/previews per project, and per environment.
		if (ctx.wants('projects'))
			for (const project of ctx.projects()) {
				const slug = String(project.slug);
				if (!ctx.wantsProject(slug)) continue;
				const assign = (label: string, policyId: unknown, input: (row: { id: string }) => Record<string, unknown>, extraDeps: string[] = []) => {
					const policy = oldPolicy(ctx, policyId);
					if (!policy) return;
					const policyName = String(policy.name);
					const where = scopeLabel(ctx, policy.scope);
					const policyKey = `accessPolicies.${where}.${policyName}`;
					const step = { key: `projects.${slug}.access.${label}`, section: 'accessPolicies', kind: 'policy assignment', name: `${slug} ${label} → ${policyName}` };
					plan.create({ ...step, dependsOn: [`projects.${slug}`, policyKey, ...extraDeps] }, () => {
						const target = ctx.resolveScope(policy.scope);
						if ('problem' in target) throw new Error(target.problem);
						const found = findPolicy(ctx, policyName, target.scope);
						if (!found) throw new Error(`access policy ${policyName} is missing`);
						const row = ctx.requireProject(slug);
						core.accessPolicies.assign(principal, row, { ...input(row), policyId: found } as never);
					});
				};
				if (project.productionAccess === 'access') assign('production', project.productionAccessPolicyId, () => ({ scope: 'production' }));
				if (project.previewAccess === 'access') assign('previews', project.previewAccessPolicyId, () => ({ scope: 'previews' }));
				for (const env of arr(project.environments)) {
					const envSlug = str(env.slug);
					if (!envSlug || env.isProduction || env.access !== 'access') continue;
					assign(
						`environment.${envSlug}`,
						env.accessPolicyId,
						() => {
							const row = ctx.environmentRow(slug, envSlug);
							if (!row) throw new Error(`environment ${slug}/${envSlug} is missing`);
							return { scope: 'environment', environmentId: row.id };
						},
						[`projects.${slug}.environments.${envSlug}`],
					);
				}
			}
	}

	if (!ctx.wants('iam')) return;
	const iam = ctx.iam();

	for (const guardrail of arr(iam.guardrails)) {
		if (!guardrail.orgId) continue; // platform guardrails are not the org's
		const name = str(guardrail.name);
		if (!name) continue;
		const step = { key: `iam.guardrails.${name}`, section: 'iam', kind: 'guardrail', name };
		if (ctx.maybe(() => core.governance.list(principal))?.some((row) => row.orgId && row.name.toLowerCase() === name.toLowerCase())) {
			plan.exists(step);
			continue;
		}
		const selector = obj(guardrail.selector);
		plan.create(step, () => {
			const principalIds = strings(selector.principalIds)
				.map((id) => userId(ctx, id) ?? (oldServiceAccountName(ctx, id) ? ctx.serviceAccountId(oldServiceAccountName(ctx, id)!) : null))
				.filter((id): id is string => !!id);
			const groupIds = strings(selector.groupIds)
				.map((id) => (oldGroupName(ctx, id) ? ctx.groupId(oldGroupName(ctx, id)!) : null))
				.filter((id): id is string => !!id);
			let scope: Record<string, unknown> | undefined;
			if (guardrail.scope) {
				const target = ctx.resolveScope(guardrail.scope);
				if ('problem' in target) throw new Error(target.problem);
				scope = target.scope;
			}
			return core.governance.create(principal, {
				name,
				permissions: strings(guardrail.permissions),
				selector: {
					...(selector.principalTypes ? { principalTypes: selector.principalTypes } : {}),
					...(principalIds.length ? { principalIds } : {}),
					...(groupIds.length ? { groupIds } : {}),
				},
				...(scope ? { scope } : {}),
				...(guardrail.condition ? { condition: guardrail.condition } : {}),
				enabled: guardrail.enabled !== false,
			} as never);
		});
	}

	const now = core.ctx.now();
	for (const binding of arr(iam.bindings)) {
		const createdBy = str(binding.createdBy) ?? '';
		const who = principalLabel(ctx, binding.principalType, binding.principalId);
		const role = str(binding.roleName) ?? str(binding.roleId) ?? '?';
		const where = scopeLabel(ctx, binding.scope);
		const step = { key: `iam.bindings.${who}.${role}.${where}`, section: 'iam', kind: 'binding', name: `${who} → ${role} @ ${where}` };
		// Base membership roles are re-created when people join; JIT grants are temporary.
		if (createdBy.startsWith(SYSTEM_PREFIX)) continue;
		if (typeof binding.expiresAt === 'number') {
			plan.skip(step, binding.expiresAt <= now ? 'expired' : 'temporary grant; request it again if still needed');
			continue;
		}
		const builtIn = arr(iam.roles).find((r) => r.id === binding.roleId)?.builtIn !== false;
		const roleName = builtIn ? String(binding.roleId) : (str(arr(iam.roles).find((r) => r.id === binding.roleId)?.name) ?? role);
		const target = principalRef(ctx, binding.principalType, binding.principalId);
		if ('problem' in target && binding.principalType === 'user') {
			plan.skip(step, target.problem);
			continue;
		}
		const existing = 'id' in target ? matchBinding(ctx, binding, target.id, builtIn ? roleName : ctx.customRoleId(roleName)) : false;
		if (existing) {
			plan.exists(step);
			continue;
		}
		const deps: string[] = [];
		if (!builtIn) deps.push(`iam.roles.${roleName}`);
		if (binding.principalType === 'group') deps.push(`iam.groups.${oldGroupName(ctx, binding.principalId) ?? ''}`);
		if (binding.principalType === 'serviceAccount') deps.push(`serviceAccounts.${oldServiceAccountName(ctx, binding.principalId) ?? ''}`);
		const scopeRef = obj(binding.scope);
		if (scopeRef.type === 'project') deps.push(`projects.${ctx.projectSlugById(scopeRef.id) ?? ''}`);
		plan.create({ ...step, dependsOn: deps }, () => {
			const who2 = principalRef(ctx, binding.principalType, binding.principalId);
			if ('problem' in who2) throw new Error(who2.problem);
			const roleId = builtIn ? roleName : ctx.customRoleId(roleName);
			if (!roleId) throw new Error(`role ${roleName} is missing`);
			const scope = ctx.resolveScope(binding.scope);
			if ('problem' in scope) throw new Error(scope.problem);
			return core.iam.bind(principal, {
				principalType: binding.principalType,
				principalId: who2.id,
				roleId,
				scope: scope.scope,
				...(str(binding.reason) ? { reason: String(binding.reason) } : {}),
			} as never);
		});
	}

	const policy = obj(iam.authPolicy);
	if (Object.keys(policy).length) {
		const step = { key: 'iam.authPolicy', section: 'iam', kind: 'auth policy', name: 'org sign-in policy' };
		const current = ctx.maybe(() => core.authPolicy.get(principal));
		const fields = ['require2fa', 'allowedMethods', 'sessionMaxAge', 'idleTimeout', 'ipAllowlist', 'autoDisableUnusedServiceAccounts'] as const;
		const wanted = pick(policy, fields, ['sessionMaxAge', 'idleTimeout']);
		// Compare only what the file holds: an older export lacks newer fields.
		const same = current && fields.filter((field) => field in policy).every((field) => JSON.stringify((current as unknown as Item)[field] ?? null) === JSON.stringify(wanted[field] ?? null));
		if (same) plan.exists(step, 'already the same here');
		else {
			plan.create(step, () => {
				const breakGlassUserIds = strings(policy.breakGlassUserIds)
					.map((id) => userId(ctx, id))
					.filter((id): id is string => !!id);
				return core.authPolicy.update(principal, { ...wanted, ...(breakGlassUserIds.length ? { breakGlassUserIds } : {}) } as never);
			});
			if (strings(policy.ipAllowlist).length)
				plan.warnings.push('The sign-in policy has an IP allowlist; make sure your own address is on it before you sign out.');
		}
		if (policy.requireSso === true)
			plan.manualStep('iam', 'sign-in policy', 'Required SSO was not turned on: set up the SSO provider again (providers are not exported), then require SSO');
	}
}

function findPolicy(ctx: ImportContext, name: string, scope: Record<string, unknown>): string | null {
	const list = ctx.maybe(() => ctx.core.accessPolicies.list(ctx.principal)) ?? [];
	const match = list.find((row) => {
		const rowScope = row.scope as unknown as Record<string, unknown>;
		return row.name === name && rowScope.type === scope.type && (rowScope.id ?? null) === (scope.id ?? null);
	});
	return match?.id ?? null;
}

/** Rewrite the ids inside a rule's matchers (groups, pools) for this instance. */
function remapRule(ctx: ImportContext, rule: Item): Item {
	const remap = (matcher: Item): Item => {
		if (matcher.type === 'orgGroup') {
			const name = oldGroupName(ctx, matcher.groupId);
			const id = name ? ctx.groupId(name) : null;
			if (!id) throw new Error(`group ${name ?? String(matcher.groupId)} is missing`);
			return { ...matcher, groupId: id };
		}
		if (matcher.type === 'userPool') {
			const name = oldPoolName(ctx, matcher.poolId);
			const id = name ? ctx.poolId(name) : null;
			if (!id) throw new Error(`user pool ${name ?? String(matcher.poolId)} is missing`);
			return { ...matcher, poolId: id };
		}
		return matcher;
	};
	return { ...pick(rule, ['idx', 'action']), matcher: remap(obj(rule.matcher)) };
}

function matchBinding(ctx: ImportContext, binding: Item, principalId: string, roleId: string | null): boolean {
	if (!roleId) return false;
	const scope = ctx.resolveScope(binding.scope);
	if ('problem' in scope) return false;
	return ctx.core.iam
		.listBindings(ctx.principal.orgId)
		.some(
			(row) =>
				row.principalType === binding.principalType &&
				row.principalId === principalId &&
				row.roleId === roleId &&
				JSON.stringify(normaliseScope(row.scope as unknown as Item)) === JSON.stringify(normaliseScope(scope.scope)),
		);
}

function normaliseScope(scope: Item): Item {
	return { type: scope.type ?? 'org', id: scope.id ?? null, projectId: scope.projectId ?? null };
}
