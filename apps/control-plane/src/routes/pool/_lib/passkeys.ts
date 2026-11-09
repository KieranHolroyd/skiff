import type {
	UserPoolPasskeyAuthenticationChallenge,
	UserPoolPasskeyRegistrationChallenge
} from '@skiff/contracts';

/**
 * Browser-side WebAuthn helpers for the hosted pool pages. They deliberately use the platform
 * WebAuthn API directly instead of pulling `@simplewebauthn/browser` into the control plane: the
 * JSON shapes below are the ones `@simplewebauthn/server` verifies.
 *
 * Nothing here touches the platform session. The endpoints it calls use only the pool's own CSRF
 * cookie and the pool session cookie, so a passkey enrolled in a pool never becomes a platform
 * credential.
 */

interface ApiErrorBody {
	error?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body),
		credentials: 'same-origin'
	});
	const parsed = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
	if (!response.ok) throw new Error(parsed.error ?? 'Passkey sign-in is unavailable. Try again.');
	return parsed;
}

/** Decode a base64url string into the ArrayBuffer a WebAuthn options member needs. */
function base64UrlToBuffer(value: string): ArrayBuffer {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

/** Encode an ArrayBuffer as the base64url string the server library expects. */
function bufferToBase64Url(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function transports(value: AuthenticatorResponse): string[] {
	const response = value as AuthenticatorAttestationResponse;
	return typeof response.getTransports === 'function' ? response.getTransports() : [];
}

export interface PasskeyRegistrationBody {
	csrf: string;
	challengeId: string;
	name: string;
	response: {
		id: string;
		rawId: string;
		type: string;
		response: { clientDataJSON: string; attestationObject: string; transports: string[] };
		clientExtensionResults: AuthenticationExtensionsClientOutputs;
		authenticatorAttachment: string | null;
	};
}

export interface PasskeyLoginBody {
	csrf: string;
	challengeId: string;
	response: {
		id: string;
		rawId: string;
		type: string;
		response: {
			clientDataJSON: string;
			authenticatorData: string;
			signature: string;
			userHandle: string | null;
		};
		clientExtensionResults: AuthenticationExtensionsClientOutputs;
		authenticatorAttachment: string | null;
	};
	email: string;
	return_to: string | null;
}

/** Whether this browser can create and use passkeys at all. */
export function passkeysSupported(): boolean {
	return typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window;
}

/** Enrol a passkey for the signed-in pool user. Resolves once the server stored the credential. */
export async function addPasskey(poolId: string, csrf: string, name: string): Promise<void> {
	const challenge = await postJson<UserPoolPasskeyRegistrationChallenge>(
		`/pool/${poolId}/passkeys/register/options`,
		{ csrf }
	);
	const options = challenge.options;
	const publicKey: PublicKeyCredentialCreationOptions = {
		challenge: base64UrlToBuffer(options.challenge),
		rp: { id: options.rp.id, name: options.rp.name },
		user: {
			id: base64UrlToBuffer(options.user.id),
			name: options.user.name,
			displayName: options.user.displayName
		},
		pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({
			alg: parameter.alg,
			type: 'public-key'
		})),
		timeout: options.timeout,
		attestation: (options.attestation as AttestationConveyancePreference | undefined) ?? 'none',
		excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
			id: base64UrlToBuffer(credential.id),
			type: 'public-key',
			transports: credential.transports as AuthenticatorTransport[] | undefined
		})),
		authenticatorSelection: {
			residentKey: 'required',
			userVerification: 'required'
		}
	};

	const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
	if (!credential) throw new Error('The passkey prompt was cancelled.');
	const response = credential.response as AuthenticatorAttestationResponse;
	const body: PasskeyRegistrationBody = {
		csrf,
		challengeId: challenge.challengeId,
		name,
		response: {
			id: credential.id,
			rawId: bufferToBase64Url(credential.rawId),
			type: credential.type,
			response: {
				clientDataJSON: bufferToBase64Url(response.clientDataJSON),
				attestationObject: bufferToBase64Url(response.attestationObject),
				transports: transports(response)
			},
			clientExtensionResults: credential.getClientExtensionResults(),
			authenticatorAttachment: credential.authenticatorAttachment
		}
	};
	await postJson(`/pool/${poolId}/passkeys/register/verify`, body);
}

/**
 * Sign in with a discoverable passkey. Returns the server-chosen redirect target; the caller
 * navigates there so the new pool session cookie is picked up.
 */
export async function signInWithPasskey(
	poolId: string,
	csrf: string,
	email: string,
	returnTo: string | null
): Promise<string> {
	const challenge = await postJson<UserPoolPasskeyAuthenticationChallenge>(
		`/pool/${poolId}/passkeys/login/options`,
		{ csrf, email }
	);
	const options = challenge.options;
	const publicKey: PublicKeyCredentialRequestOptions = {
		challenge: base64UrlToBuffer(options.challenge),
		rpId: options.rpId,
		timeout: options.timeout,
		userVerification: 'required',
		allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
			id: base64UrlToBuffer(credential.id),
			type: 'public-key',
			transports: credential.transports as AuthenticatorTransport[] | undefined
		}))
	};

	const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
	if (!assertion) throw new Error('The passkey prompt was cancelled.');
	const response = assertion.response as AuthenticatorAssertionResponse;
	const body: PasskeyLoginBody = {
		csrf,
		challengeId: challenge.challengeId,
		email,
		return_to: returnTo,
		response: {
			id: assertion.id,
			rawId: bufferToBase64Url(assertion.rawId),
			type: assertion.type,
			response: {
				clientDataJSON: bufferToBase64Url(response.clientDataJSON),
				authenticatorData: bufferToBase64Url(response.authenticatorData),
				signature: bufferToBase64Url(response.signature),
				userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null
			},
			clientExtensionResults: assertion.getClientExtensionResults(),
			authenticatorAttachment: assertion.authenticatorAttachment
		}
	};
	const result = await postJson<{ redirect: string }>(`/pool/${poolId}/passkeys/login/verify`, body);
	return result.redirect;
}

/** A friendly message for the WebAuthn errors a person can actually cause. */
export function passkeyErrorMessage(error: unknown): string {
	if (error instanceof DOMException && error.name === 'NotAllowedError')
		return 'The passkey prompt was cancelled or timed out. Try again.';
	if (error instanceof DOMException && error.name === 'InvalidStateError')
		return 'That passkey is already registered on this device.';
	return error instanceof Error ? error.message : 'Could not use a passkey. Try again.';
}
