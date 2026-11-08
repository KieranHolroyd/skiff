import {
	accessPolicyRuleSchema,
	type AccessPolicy,
	type AccessPolicyMatcher,
	type AccessPolicyRule,
} from '@skiff/contracts';

/**
 * The compact text form used by Settings → Access policies. One rule per line:
 * `<allow|deny> <matcher> [args…]`. Blank lines and `#` comments are ignored. Kept out of the
 * route's server module so the page can format a policy for the editor without bundling the server.
 */

function parseMatcher(parts: string[]): AccessPolicyMatcher {
	const [kind, ...rest] = parts;
	switch (kind) {
		case 'member':
		case 'any':
			return { type: 'anyMember' };
		case 'group':
			return { type: 'orgGroup', groupId: required(rest[0], 'A group rule needs a group id.') };
		case 'email':
			return { type: 'email', email: required(rest[0], 'An email rule needs an address.').toLowerCase() };
		case 'domain':
			return { type: 'emailDomain', domain: required(rest[0], 'A domain rule needs a domain.').toLowerCase() };
		case 'sso':
			return { type: 'ssoProvider', providerId: required(rest[0], 'An SSO rule needs a provider id.') };
		case 'pool': {
			const groups = (rest[1] ?? '')
				.split(',')
				.map((group) => group.trim())
				.filter(Boolean);
			return { type: 'userPool', poolId: required(rest[0], 'A pool rule needs a pool id.'), groups };
		}
		case 'cidr': {
			const cidrs = rest
				.join(' ')
				.split(',')
				.map((cidr) => cidr.trim())
				.filter(Boolean);
			return { type: 'cidr', cidrs };
		}
		case 'token':
			return {
				type: 'serviceToken',
				header: required(rest[0], 'A token rule needs a header name.'),
				tokenHash: required(rest[1], 'A token rule needs the SHA-256 of the token value.'),
			};
		default:
			throw new Error(`Unknown matcher "${kind ?? ''}".`);
	}
}

function required(value: string | undefined, message: string): string {
	if (!value) throw new Error(message);
	return value;
}

export function parseRuleLines(text: string): AccessPolicyRule[] {
	const rules: AccessPolicyRule[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const [action, ...parts] = line.split(/\s+/);
		if (action !== 'allow' && action !== 'deny')
			throw new Error(`Line "${line}" must start with allow or deny.`);
		const matcher = parseMatcher(parts);
		rules.push(accessPolicyRuleSchema.parse({ idx: rules.length, action, matcher }));
	}
	return rules;
}

export function rulesToText(policy: Pick<AccessPolicy, 'rules'>): string {
	return policy.rules.map((rule) => `${rule.action} ${matcherToText(rule.matcher)}`).join('\n');
}

function matcherToText(matcher: AccessPolicyMatcher): string {
	switch (matcher.type) {
		case 'anyMember':
			return 'member';
		case 'orgGroup':
			return `group ${matcher.groupId}`;
		case 'email':
			return `email ${matcher.email}`;
		case 'emailDomain':
			return `domain ${matcher.domain}`;
		case 'ssoProvider':
			return `sso ${matcher.providerId}`;
		case 'userPool':
			return `pool ${matcher.poolId}${matcher.groups.length ? ` ${matcher.groups.join(',')}` : ''}`;
		case 'cidr':
			return `cidr ${matcher.cidrs.join(',')}`;
		case 'serviceToken':
			return `token ${matcher.header} ${matcher.tokenHash}`;
	}
}
