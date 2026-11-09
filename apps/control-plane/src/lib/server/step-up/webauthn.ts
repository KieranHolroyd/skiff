import { createRequire } from 'node:module';

/**
 * `@simplewebauthn/server` is a dependency of `@better-auth/passkey` (STEP-UP.md §5 says so), not
 * of the control plane. Resolve it through the passkey package so step-up verification always uses
 * the exact version the sign-in plugin stores credentials with, and so the app does not add a
 * second copy to its own dependency list.
 */
export interface WebAuthnServer {
	generateAuthenticationOptions(options: {
		rpID: string;
		userVerification: 'required' | 'preferred' | 'discouraged';
		allowCredentials?: Array<{ id: string; transports?: string[] }>;
	}): Promise<StepUpAuthenticationOptions>;
	verifyAuthenticationResponse(options: {
		response: StepUpAuthenticationResponse;
		expectedChallenge: string;
		expectedOrigin: string;
		expectedRPID: string;
		credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
		requireUserVerification: boolean;
	}): Promise<{ verified: boolean; authenticationInfo: { newCounter: number } }>;
}

export interface StepUpAuthenticationOptions {
	challenge: string;
	rpId?: string;
	timeout?: number;
	userVerification?: string;
	allowCredentials?: Array<{ id: string; type?: string; transports?: string[] }>;
	extensions?: Record<string, unknown>;
}

export interface StepUpAuthenticationResponse {
	id: string;
	rawId: string;
	type: string;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string | null;
	};
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: string | null;
}

let loaded: WebAuthnServer | undefined;

export function webAuthnServer(): WebAuthnServer {
	if (loaded) return loaded;
	const here = createRequire(import.meta.url);
	try {
		// The exact copy the passkey plugin uses, so the stored credential format always matches.
		const passkeyEntry = here.resolve('@better-auth/passkey');
		loaded = createRequire(passkeyEntry)('@simplewebauthn/server') as WebAuthnServer;
	} catch {
		// A future install that adds the package directly still works.
		loaded = here('@simplewebauthn/server') as WebAuthnServer;
	}
	return loaded;
}
