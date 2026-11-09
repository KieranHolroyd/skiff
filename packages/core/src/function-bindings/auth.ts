import { USER_POOL_AUTH_BINDING } from '@yoal/contracts';
import type { BindingResolver } from './types.ts';

/**
 * `env.AUTH` for a function (IAM.md I28, §11.2).
 *
 * Resolution proves the project has a pool attachment and copies its issuer and **public** JWKS
 * into the runtime binding. The node embeds that JWKS in a small service Worker, so
 * `env.AUTH.verify(request)` verifies an access token locally without a network hop. Nothing
 * secret crosses this seam: the client secret reaches the function only through activation env.
 */
export const resolveAuthBinding: BindingResolver = async ({ core, project }, binding) => {
	if (binding.type !== 'auth')
		throw new Error(`Auth resolver received a "${binding.type}" binding.`);
	const resolved = await core.userPools.authBindingForProject(project.id, binding.pool);
	// The manifest may name the binding anything, but `env.AUTH` is the documented contract.
	return { ...resolved, name: binding.name || USER_POOL_AUTH_BINDING };
};

/** True when a manifest binding already claims `AUTH`, so the automatic attachment binding is not duplicated. */
export function isAuthBindingName(name: string): boolean {
	return name === USER_POOL_AUTH_BINDING;
}

// Re-exported so the function service's error can name the same contract constant.
export { USER_POOL_AUTH_BINDING };
