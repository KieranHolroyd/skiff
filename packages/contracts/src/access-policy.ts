import * as z from 'zod';

/**
 * Skiff Access policies (IAM.md I25, §11.1).
 *
 * A policy is an ordered list of allow/deny rules. Each rule matches one thing: an org group, any
 * org member, an email or email domain, an SSO provider, a user pool and its groups, a CIDR, or a
 * service token (a header pair for machines). The evaluator is pure so the platform and the tests
 * agree on the decision; the agent only ever verifies the host-bound session the platform issued.
 *
 * Evaluation order is deliberately simple and fails closed:
 *  - a matching deny beats every allow, wherever it sits in the list;
 *  - otherwise the first matching allow wins;
 *  - no match denies, and an unauthenticated visitor is sent to sign in when the policy contains
 *    identity rules that could still match them.
 */

export const accessPolicyActions = ['allow', 'deny'] as const;
export type AccessPolicyAction = (typeof accessPolicyActions)[number];

export const accessPolicyScopeTypes = ['org', 'project', 'environment'] as const;
export type AccessPolicyScopeType = (typeof accessPolicyScopeTypes)[number];

export const accessPolicyScopeSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('org') }),
	z.object({ type: z.literal('project'), id: z.string().min(1).max(100) }),
	z.object({
		type: z.literal('environment'),
		id: z.string().min(1).max(100),
		projectId: z.string().min(1).max(100),
	}),
]);
export type AccessPolicyScope = z.infer<typeof accessPolicyScopeSchema>;

const EMAIL = z.string().trim().toLowerCase().email().max(320);
const DOMAIN = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(253)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/);

/** The matcher stored in `access_policy_rules.matcher_json`. */
export const accessPolicyMatcherSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('orgGroup'), groupId: z.string().min(1).max(100) }),
	z.object({ type: z.literal('anyMember') }),
	z.object({ type: z.literal('email'), email: EMAIL }),
	z.object({ type: z.literal('emailDomain'), domain: DOMAIN }),
	z.object({ type: z.literal('ssoProvider'), providerId: z.string().min(1).max(100) }),
	z.object({
		type: z.literal('userPool'),
		poolId: z.string().min(1).max(100),
		/** Empty = any user in the pool. */
		groups: z.array(z.string().min(1).max(100)).max(100).default([]),
	}),
	z.object({ type: z.literal('cidr'), cidrs: z.array(z.string().min(1).max(64)).min(1).max(50) }),
	z.object({
		type: z.literal('serviceToken'),
		/** Header name, e.g. `x-skiff-token`. */
		header: z.string().trim().regex(/^[A-Za-z0-9-]{1,80}$/),
		/** Lowercase hex SHA-256 of the header value; the value itself is never stored. */
		tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
	}),
]);
export type AccessPolicyMatcher = z.infer<typeof accessPolicyMatcherSchema>;

export const accessPolicyRuleSchema = z.object({
	/** Position in the ordered list; the evaluator sorts by it. */
	idx: z.number().int().min(0).max(1_000),
	action: z.enum(accessPolicyActions),
	matcher: accessPolicyMatcherSchema,
});
export type AccessPolicyRule = z.infer<typeof accessPolicyRuleSchema>;

export const accessPolicyRulesSchema = z.array(accessPolicyRuleSchema).max(100);

export const accessPolicyCreateSchema = z.object({
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(500).default(''),
	scope: accessPolicyScopeSchema,
	enabled: z.boolean().default(true),
	rules: accessPolicyRulesSchema.default([]),
});
export type AccessPolicyCreate = z.infer<typeof accessPolicyCreateSchema>;

export const accessPolicyUpdateSchema = z
	.object({
		name: z.string().trim().min(1).max(80).optional(),
		description: z.string().trim().max(500).optional(),
		enabled: z.boolean().optional(),
		rules: accessPolicyRulesSchema.optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update.');
export type AccessPolicyUpdate = z.infer<typeof accessPolicyUpdateSchema>;

/** The policy as stored and returned. `rules` keep their stored order (`idx`). */
export interface AccessPolicy {
	id: string;
	orgId: string;
	name: string;
	description: string;
	scope: AccessPolicyScope;
	enabled: boolean;
	rules: AccessPolicyRule[];
	createdAt: number;
	updatedAt: number;
}

/** Who is asking. Every field is optional so a machine request can be evaluated without a person. */
export interface AccessIdentity {
	userId?: string | null;
	email?: string | null;
	orgId?: string | null;
	/** `iam_groups.id` values the user belongs to. */
	groups?: readonly string[];
	/** A member of the org (anyMember). */
	member?: boolean;
	/** The SSO provider that authenticated them, when the sign-in used one. */
	ssoProviderId?: string | null;
	/** The user pool and pool groups, when the visitor signed into an app-backed pool. */
	userPoolId?: string | null;
	poolGroups?: readonly string[];
}

export interface AccessRequestContext {
	ip?: string | null;
	headers?: Readonly<Record<string, string | undefined>>;
}

export type AccessPolicyDecision = 'allow' | 'deny' | 'login';

/**
 * The service-token subset of a policy, in the shape the edge needs. The agent never sees the
 * whole policy: only header names, hashes and actions, so a matching token can be allowed before
 * an unauthenticated browser is redirected to the platform.
 */
export interface AccessServiceTokenRule {
	header: string;
	tokenHash: string;
	action: AccessPolicyAction;
}

export type AccessEdgeDecision =
	| { decision: 'allow'; header: string }
	| { decision: 'deny'; header?: string }
	| { decision: 'login' };

/** Service-token rules from a stored policy, with header names normalised for lookup. */
export function serviceTokenRules(
	policy: Pick<AccessPolicy, 'rules'>,
): AccessServiceTokenRule[] {
	return policy.rules.flatMap((rule) =>
		rule.matcher.type === 'serviceToken'
			? [
					{
						header: rule.matcher.header.toLowerCase(),
						tokenHash: rule.matcher.tokenHash.toLowerCase(),
						action: rule.action,
					},
				]
			: [],
	);
}

/**
 * The edge's pre-redirect decision (IAM.md I25, §11.1). A matching service token is decided from
 * the request headers alone; a matching deny wins over an allow. When no token matches, the agent
 * only knows to send the visitor to login if the policy also has a rule a person could satisfy —
 * a machine-only policy ends in deny, never a pointless login redirect.
 */
export function evaluateAccessEdge(
	rules: readonly AccessServiceTokenRule[],
	headers: Readonly<Record<string, string | undefined>>,
	hasPersonRules: boolean,
): AccessEdgeDecision {
	let allowedHeader: string | null = null;
	for (const rule of rules) {
		const value = headers[rule.header.toLowerCase()];
		if (typeof value !== 'string' || value.length === 0) continue;
		if (!timingSafeHexEqual(sha256Hex(value), rule.tokenHash)) continue;
		if (rule.action === 'deny') return { decision: 'deny', header: rule.header };
		allowedHeader ??= rule.header;
	}
	if (allowedHeader) return { decision: 'allow', header: allowedHeader };
	return hasPersonRules ? { decision: 'login' } : { decision: 'deny' };
}

const MACHINE_MATCHERS = new Set<AccessPolicyMatcher['type']>(['cidr', 'serviceToken']);

function hasIdentity(identity: AccessIdentity): boolean {
	return Boolean(
		identity.userId ||
			identity.email ||
			identity.member ||
			(identity.groups && identity.groups.length > 0) ||
			identity.ssoProviderId ||
			identity.userPoolId,
	);
}

function matches(matcher: AccessPolicyMatcher, identity: AccessIdentity, request: AccessRequestContext): boolean {
	const email = identity.email?.trim().toLowerCase() ?? '';
	switch (matcher.type) {
		case 'anyMember':
			return identity.member === true;
		case 'orgGroup':
			return (identity.groups ?? []).includes(matcher.groupId);
		case 'email':
			return email.length > 0 && email === matcher.email;
		case 'emailDomain': {
			const at = email.lastIndexOf('@');
			return at >= 0 && email.slice(at + 1) === matcher.domain;
		}
		case 'ssoProvider':
			return Boolean(identity.ssoProviderId) && identity.ssoProviderId === matcher.providerId;
		case 'userPool':
			if (identity.userPoolId !== matcher.poolId) return false;
			return matcher.groups.length === 0 || matcher.groups.some((group) => (identity.poolGroups ?? []).includes(group));
		case 'cidr':
			return Boolean(request.ip) && matcher.cidrs.some((cidr) => policyIpInCidr(request.ip!, cidr));
		case 'serviceToken': {
			const value = request.headers?.[matcher.header.toLowerCase()];
			return typeof value === 'string' && value.length > 0 && sha256Hex(value) === matcher.tokenHash;
		}
		default:
			// An unknown matcher fails closed.
			return false;
	}
}

/**
 * Decide what a visitor may do. `login` means "no identity yet, but signing in could match" and is
 * what the platform redirects on; it is never returned for an authenticated principal.
 */
export function evaluateAccessPolicy(
	policy: Pick<AccessPolicy, 'enabled' | 'rules'>,
	identity: AccessIdentity,
	request: AccessRequestContext = {},
): AccessPolicyDecision {
	if (!policy.enabled) return 'deny';
	const rules = [...policy.rules].sort((left, right) => left.idx - right.idx);
	let allowed = false;
	for (const rule of rules) {
		if (!matches(rule.matcher, identity, request)) continue;
		// Deny wins: scan the whole list for a deny before honouring an earlier allow.
		if (rule.action === 'deny') return 'deny';
		allowed = true;
	}
	if (allowed) return 'allow';
	if (hasIdentity(identity)) return 'deny';
	// No identity yet. If every matcher is machine-only, signing in cannot help, so fail closed.
	const couldMatchPerson = rules.some((rule) => !MACHINE_MATCHERS.has(rule.matcher.type));
	return couldMatchPerson ? 'login' : 'deny';
}

/** IPv4 CIDR or bare address, matching `authorize`'s rule. IPv6 fails closed for now. */
function policyIpInCidr(ip: string, cidr: string): boolean {
	const [network, bitsRaw] = cidr.trim().split('/');
	const address = parseIpv4(ip);
	const base = parseIpv4(network ?? '');
	if (address === null || base === null) return false;
	const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	if (bits === 0) return true;
	const mask = (0xffffffff << (32 - bits)) >>> 0;
	return (address & mask) === (base & mask);
}

function parseIpv4(value: string): number | null {
	const parts = value.trim().split('.');
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		result = ((result << 8) | octet) >>> 0;
	}
	return result;
}

// ---------------------------------------------------------------- service tokens

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

/** Constant-time comparison for lowercase hex digests; a length mismatch is already a failure. */
function timingSafeHexEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index += 1)
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

/** Small synchronous SHA-256 so the evaluator stays pure (Web Crypto's digest is async). */
export function sha256Hex(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const bitLength = bytes.length * 8;
	const total = Math.ceil((bytes.length + 9) / 64) * 64;
	const buffer = new Uint8Array(total);
	buffer.set(bytes);
	buffer[bytes.length] = 0x80;
	const view = new DataView(buffer.buffer);
	view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000));
	view.setUint32(total - 4, bitLength >>> 0);

	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const schedule = new Uint32Array(64);
	for (let offset = 0; offset < total; offset += 64) {
		for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i += 1) {
			const s0 = rotr(schedule[i - 15]!, 7) ^ rotr(schedule[i - 15]!, 18) ^ (schedule[i - 15]! >>> 3);
			const s1 = rotr(schedule[i - 2]!, 17) ^ rotr(schedule[i - 2]!, 19) ^ (schedule[i - 2]! >>> 10);
			schedule[i] = (schedule[i - 16]! + s0 + schedule[i - 7]! + s1) >>> 0;
		}
		let a = hash[0]!, b = hash[1]!, c = hash[2]!, d = hash[3]!;
		let e = hash[4]!, f = hash[5]!, g = hash[6]!, h = hash[7]!;
		for (let i = 0; i < 64; i += 1) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temp1 = (h + s1 + choice + SHA256_K[i]! + schedule[i]!) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (s0 + majority) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		hash[0] = (hash[0]! + a) >>> 0;
		hash[1] = (hash[1]! + b) >>> 0;
		hash[2] = (hash[2]! + c) >>> 0;
		hash[3] = (hash[3]! + d) >>> 0;
		hash[4] = (hash[4]! + e) >>> 0;
		hash[5] = (hash[5]! + f) >>> 0;
		hash[6] = (hash[6]! + g) >>> 0;
		hash[7] = (hash[7]! + h) >>> 0;
	}
	return Array.from(hash, (value) => value.toString(16).padStart(8, '0')).join('');
}
