import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import authWorkerSource from '../../../../packages/function-bindings/src/auth.js' with { type: 'text' };

/** Helper credential name the auth service module is embedded as (fixed contract with the helper). */
export const AUTH_BINDING_FILE = 'binding-auth';

/**
 * `env.AUTH` from a user-pool attachment (IAM.md I28, §11.2).
 *
 * The main Worker gets a service binding to a sibling `Auth` entrypoint. That Worker holds the
 * pool's public JWKS and issuer as text bindings, so `verify(request)` checks ES256 locally and
 * returns the user or null. The client secret is not here: it reaches the function through the
 * ordinary activation env (`<P>_CLIENT_SECRET`), never the rendered config.
 */
export const renderAuthBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'auth')
		throw new Error(`Auth renderer received binding "${binding.name}" of type "${binding.type}", not "auth".`);
	const spec = workload.function;
	if (!spec)
		throw new Error(`Cannot render an auth binding for workload ${workload.id}: it has no function spec.`);

	const serviceName = `auth-${index}`;
	const services = [
		[
			`    ( name = ${capnpText(serviceName)},`,
			'      worker = (',
			'        modules = [',
			`          ( name = "auth.js", esModule = embed ${capnpText(AUTH_BINDING_FILE)} ),`,
			'        ],',
			`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
			'        compatibilityFlags = [],',
			'        bindings = [',
			`          ( name = "AUTH_JWKS", text = ${capnpText(JSON.stringify(binding.jwks))} ),`,
			`          ( name = "AUTH_ISSUER", text = ${capnpText(binding.issuer)} ),`,
			'        ],',
			'      ) )'
		].join('\n')
	];

	const rendered: RenderedBinding = {
		files: { [AUTH_BINDING_FILE]: authWorkerSource },
		services,
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, service = ( name = ${capnpText(serviceName)}, entrypoint = "Auth" ) )`
		],
		requiresDurableStorage: false,
		namespaces: []
	};
	return rendered;
};
