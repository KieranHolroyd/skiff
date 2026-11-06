import * as z from 'zod';

/**
 * Cross-node service endpoints (docs/CLUSTERING.md §4.3, phase C2).
 *
 * A consumer node owns one stable loopback port per attached remote service. The provider node
 * exposes only its loopback port over the overlay, behind mTLS and a per-attachment firewall
 * grant. Failover changes the endpoint's upstream, not the consumer's environment.
 */

export const serviceKinds = ['database', 'storage'] as const;
export type ServiceKind = (typeof serviceKinds)[number];

export const endpointPortRange = { min: 21_000, max: 21_999 } as const;

export const serviceEndpointSchema = z.object({
	id: z.string().min(1).max(100),
	kind: z.enum(serviceKinds),
	serviceId: z.string().min(1).max(100),
	/** Consumer-side loopback port; stable across a provider move. */
	localPort: z.number().int().min(endpointPortRange.min).max(endpointPortRange.max),
	upstream: z.object({
		nodeId: z.string().min(1).max(100),
		/** Provider overlay address; null until the overlay address is known. */
		address: z.string().max(64).nullable().default(null),
		port: z.number().int().min(1).max(65_535),
	}),
	/** SHA-256 of the provider leaf certificate, for the consumer's mTLS pin. */
	tlsFingerprint: z.string().max(128).nullable().default(null),
});
export type ServiceEndpoint = z.infer<typeof serviceEndpointSchema>;

/** A public node certificate stored by the control plane; the private key never arrives here. */
export const nodeCertificateSchema = z.object({
	nodeId: z.string().min(1).max(100),
	serial: z.string().min(1).max(100),
	certPem: z.string().min(1).max(16_384),
	caSerial: z.string().max(100).nullable().default(null),
	issuedAt: z.string().max(40),
	expiresAt: z.string().max(40),
	revokedAt: z.string().max(40).nullable().default(null),
});
export type NodeCertificate = z.infer<typeof nodeCertificateSchema>;

/** Provider-side listener: one overlay port forwarding to a local loopback service (C2). */
export const serviceProviderSchema = z.object({
	id: z.string().min(1).max(100),
	listenAddress: z.string().min(1).max(64),
	listenPort: z.number().int().min(1).max(65_535),
	targetPort: z.number().int().min(1).max(65_535),
	/** SHA-256 fingerprints of consumer node certificates allowed to connect (pinned mTLS). */
	allowedClientFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(64).default([]),
});
export type ServiceProvider = z.infer<typeof serviceProviderSchema>;

/** The node's public certificate plus its pinned fingerprint (C2 interim identity). */
export const nodeIdentityCertificateSchema = z.object({
	certPem: z.string().min(1).max(16_384),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	expiresAt: z.string().max(40),
});
export type NodeIdentityCertificate = z.infer<typeof nodeIdentityCertificateSchema>;
