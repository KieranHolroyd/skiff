import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin, jwt, magicLink, organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { createAccessControl } from 'better-auth/plugins/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { allPermissions, roles, statements, type Permission, type Role } from '@skiff/contracts';
import { getRequestEvent } from '$app/server';
import { allowDcr, authSecret, contentDomain, devPasswordLogin, github, mcpResource, openSignup, platformOrigin } from './config';
import { sendInviteEmail, sendMagicLinkEmail } from './email';
import { sqlite } from './db';

/**
 * Better Auth: passkeys + GitHub, invite-only, 2FA for owners (D10); organizations with the
 * same RBAC statements the API/MCP/CLI use (D9); API keys and MCP OAuth 2.1 (D11).
 */
const ac = createAccessControl(statements);

function statementsFor(role: Role): Record<string, string[]> {
	const grouped: Record<string, string[]> = {};
	for (const permission of roles[role] as readonly Permission[]) {
		const [resource, action] = permission.split(':') as [string, string];
		(grouped[resource] ??= []).push(action);
	}
	return grouped;
}

const organizationRoles = {
	owner: ac.newRole(statementsFor('owner')),
	admin: ac.newRole(statementsFor('admin')),
	deployer: ac.newRole(statementsFor('deployer')),
	viewer: ac.newRole(statementsFor('viewer')),
};

const secure = platformOrigin.startsWith('https://');
const platformHost = new URL(platformOrigin).hostname;

export const auth = betterAuth({
	baseURL: platformOrigin,
	secret: authSecret,
	database: sqlite,
	emailAndPassword: { enabled: devPasswordLogin },
	socialProviders: github
		? { github: { clientId: github.clientId, clientSecret: github.clientSecret } }
		: {},
	trustedOrigins: [platformOrigin],
	databaseHooks: {
		user: {
			create: {
				// Invite-only (D10), with the very first user allowed so the setup wizard can create
				// the owner. Invitations are Better Auth organization invitations by email.
				before: async (user) => {
					if (openSignup) return;
					const count = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user').get();
					if ((count?.count ?? 0) === 0) return;
					const invited = sqlite
						.query<{ id: string }, [string, number]>(
							"SELECT id FROM invitation WHERE email = ? AND status = 'pending' AND expiresAt > ?",
						)
						.get(user.email.toLowerCase(), Date.now());
					if (!invited)
						throw new APIError('FORBIDDEN', {
							message: 'Skiff is invite-only. Ask an owner to invite your email address.',
						});
				},
			},
		},
	},
	advanced: {
		// `__Host-` cookies only (DESIGN §5, D19): no Domain attribute, Secure, Path=/.
		cookiePrefix: secure ? '__Host-skiff' : 'skiff',
		useSecureCookies: secure,
	},
	plugins: [
		// Stable signing key for access/ID tokens + /jwks (required by mcp()).
		jwt(),
		// mcp() *is* the OAuth 2.1 provider — never also register oauthProvider().
		mcp({
			resource: mcpResource,
			loginPage: '/login',
			consentPage: '/consent',
			scopes: ['openid', 'profile', 'email', 'offline_access', ...allPermissions],
			allowDynamicClientRegistration: allowDcr,
			allowUnauthenticatedClientRegistration: allowDcr,
			clientRegistrationDefaultApplicationType: 'infer',
		}),
		cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
		organization({
			ac,
			roles: organizationRoles,
			creatorRole: 'owner',
			allowUserToCreateOrganization: true,
			organizationLimit: 10,
			membershipLimit: 100,
			sendInvitationEmail: async ({ id, email, organization }) => {
				await sendInviteEmail(
					email,
					organization.name,
					`${platformOrigin}/accept-invitation/${id}`,
				);
			},
		}),
		admin(),
		passkey({ rpID: platformHost, rpName: 'Skiff', origin: platformOrigin }),
		twoFactor({ issuer: 'Skiff' }),
		apiKey({ defaultPrefix: 'skif_', enableMetadata: true }),
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				await sendMagicLinkEmail(email, url);
			},
		}),
		sveltekitCookies(getRequestEvent),
	],
});

export type Session = typeof auth.$Infer.Session;
export { contentDomain };
