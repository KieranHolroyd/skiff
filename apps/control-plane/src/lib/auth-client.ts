import { createAuthClient } from 'better-auth/svelte';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';
import { magicLinkClient, organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import { apiKeyClient } from '@better-auth/api-key/client';
import { ssoClient } from '@better-auth/sso/client';

/**
 * Browser auth client. oauthProviderClient forwards the signed `oauth_query` so sign-in resumes OAuth
 * flows. twoFactorClient answers the code step after a password sign-in for accounts with an
 * authenticator app (the login page handles the redirect itself, so no `onTwoFactorRedirect`).
 */
export const authClient = createAuthClient({
	plugins: [
		oauthProviderClient(),
		magicLinkClient(),
		organizationClient(),
		passkeyClient(),
		apiKeyClient(),
		twoFactorClient(),
		// Email-first sign-in: `authClient.signIn.sso({ email, callbackURL })` routes to the org's IdP.
		ssoClient()
	],
});
