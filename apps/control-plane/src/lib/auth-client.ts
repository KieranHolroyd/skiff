import { createAuthClient } from 'better-auth/svelte';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

/** Browser auth client. oauthProviderClient forwards the signed `oauth_query` so sign-in resumes OAuth flows. */
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
