/**
 * RustFS STS for attached storage (docs/IAM.md I18, §7.4; docs/OBJECT-STORAGE.md S4).
 *
 * The pinned RustFS 1.0.4 build serves `POST /` with an `Action=AssumeRoleWithWebIdentity`
 * form body, verifies the token against an external OIDC issuer configured through
 * `RUSTFS_IDENTITY_OPENID_*`, and returns the usual STS XML. Skiff signs a short-lived workload
 * token whose `groups` claim names the attachment's scoped IAM policy; RustFS maps that claim to
 * the policy and the request's inline `Policy` narrows the session to the requested bucket.
 *
 * The control plane reaches the instance through the same internal S3 gateway as the object
 * browser (D82): the request is sent to the loopback/WireGuard endpoint but carries the
 * `s3-<id>.storage.internal` Host that Caddy routes on.
 */
import {
	STORAGE_STS_AUDIENCE,
	STORAGE_STS_MAX_SESSION_POLICY_BYTES,
	STORAGE_STS_TTL_SECONDS,
	storageUserPolicy,
	type StorageGrant,
} from '@skiff/contracts';
import { unescapeXml, xmlTag } from './storage-s3.ts';

/** The RustFS STS endpoint existed from 1.0.4; anything else must fall back to sealed keys. */
export class StorageStsUnavailableError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null,
	) {
		super(message);
		this.name = 'StorageStsUnavailableError';
	}
}

export interface StorageStsRequestInput {
	/** Gateway root, e.g. `http://127.0.0.1:8081` or `http://gateway.test`. */
	endpoint: string;
	/** The instance's internal host (`s3-<hex>.storage.internal`), preserved as `Host`. */
	host: string;
	/** The workload JWT. It is the authentication for this call; no SigV4 is used. */
	token: string;
	/** Inline session policy, further narrowing the mapped IAM policy. */
	policy?: Record<string, unknown>;
	durationSeconds?: number;
	roleSessionName?: string;
}

export interface StorageStsIssued {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
	/** RustFS's `<Expiration>` value (RFC 3339). */
	expiration: string;
}

/** The slice of `fetch` this module needs, so a test can inject one without Bun's `preconnect`. */
export type StorageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The form body RustFS parses. `Action` and `Version` select the handler; `WebIdentityToken` is
 * the only authentication. `RoleSessionName` is accepted (and ignored for authorization) so the
 * call looks like the AWS SDK's.
 */
export function storageStsForm(input: StorageStsRequestInput): URLSearchParams {
	const duration = input.durationSeconds ?? STORAGE_STS_TTL_SECONDS;
	const form = new URLSearchParams({
		Action: 'AssumeRoleWithWebIdentity',
		Version: '2011-06-15',
		WebIdentityToken: input.token,
		DurationSeconds: String(duration),
		RoleSessionName: input.roleSessionName ?? 'skiff-storage',
	});
	if (input.policy) {
		const encoded = JSON.stringify(input.policy);
		if (Buffer.byteLength(encoded) > STORAGE_STS_MAX_SESSION_POLICY_BYTES)
			throw new StorageStsUnavailableError(
				`The attachment's session policy is larger than RustFS accepts (${STORAGE_STS_MAX_SESSION_POLICY_BYTES} bytes).`,
			);
		form.set('Policy', encoded);
	}
	return form;
}

/** Parse `AssumeRoleWithWebIdentityResponse`; a missing credential is a hard failure. */
export function parseStorageStsXml(xml: string): StorageStsIssued {
	const accessKeyId = xmlTag(xml, 'AccessKeyId');
	const secretAccessKey = xmlTag(xml, 'SecretAccessKey');
	const sessionToken = xmlTag(xml, 'SessionToken');
	const expiration = xmlTag(xml, 'Expiration');
	if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) {
		const code = xmlTag(xml, 'Code') ?? 'InvalidResponse';
		const message = xmlTag(xml, 'Message') ?? 'RustFS STS returned no temporary credentials.';
		throw new StorageStsUnavailableError(`${code}: ${message}`);
	}
	return {
		accessKeyId: unescapeXml(accessKeyId),
		secretAccessKey: unescapeXml(secretAccessKey),
		sessionToken: unescapeXml(sessionToken),
		expiration: unescapeXml(expiration),
	};
}

/**
 * Call the instance's STS endpoint. The request is unauthenticated by design; the workload token
 * in the body is what RustFS verifies, so no root key or attachment secret is involved.
 */
export async function requestStorageSts(
	input: StorageStsRequestInput,
	fetchImpl: StorageFetch = (url, init) => globalThis.fetch(url, init),
): Promise<StorageStsIssued> {
	const form = storageStsForm(input);
	const headers = new Headers({
		'content-type': 'application/x-www-form-urlencoded',
		// Caddy routes by this host and RustFS verifies the same value; the connection still goes
		// to the gateway endpoint above.
		host: input.host,
	});
	const endpoint = input.endpoint.replace(/\/+$/, '');
	let response: Response;
	try {
		response = await fetchImpl(`${endpoint}/`, {
			method: 'POST',
			headers,
			body: form.toString(),
		});
	} catch (error) {
		throw new StorageStsUnavailableError(
			`RustFS STS could not be reached: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const xml = await response.text().catch(() => '');
	if (!response.ok) {
		const code = xmlTag(xml, 'Code') ?? `HTTP${response.status}`;
		const message = xmlTag(xml, 'Message') ?? response.statusText;
		throw new StorageStsUnavailableError(`RustFS STS ${code}: ${message}`, response.status);
	}
	return parseStorageStsXml(xml);
}

/** The inline session policy for the attachment's grants (or one bucket of them). */
export function storageStsSessionPolicy(
	grants: readonly StorageGrant[],
	bucket?: string,
): Record<string, unknown> | undefined {
	const selected = bucket ? grants.filter((grant) => grant.bucket === bucket) : [...grants];
	if (selected.length === 0) return undefined;
	return storageUserPolicy(selected);
}

/** The audience a workload token must use for RustFS; overridable by the caller. */
export function storageStsAudience(audience?: string): string {
	return audience?.trim() || STORAGE_STS_AUDIENCE;
}
