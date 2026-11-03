import * as z from 'zod';

/**
 * Custom domains (DESIGN §5, D31). Every hostname is proved before Caddy will issue a certificate:
 * a DNS TXT record carries a random token, and Caddy's on-demand TLS `ask` endpoint only approves
 * hostnames the control plane lists as verified.
 */

export const domainStatuses = ['pending', 'verified', 'active', 'failed'] as const;
export type DomainStatus = (typeof domainStatuses)[number];

/** `apex` records also create/redirect the `www` sibling; `custom` is a plain hostname. */
export const domainKinds = ['custom', 'apex'] as const;
export type DomainKind = (typeof domainKinds)[number];

export const domainCreateSchema = z.object({
	project: z.string().min(3).max(40),
	hostname: z
		.string()
		.min(4)
		.max(253)
		.transform((value) => value.trim().toLowerCase().replace(/\.$/, ''))
		.refine(
			(value) => /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/.test(value),
			'Enter a hostname like example.com or app.example.com (no scheme, port or path)',
		),
	/** Add the `www` sibling and redirect it to the apex (or the reverse). */
	redirectWww: z.boolean().default(false),
});
export type DomainCreateInput = z.infer<typeof domainCreateSchema>;

export const domainUpdateSchema = z.object({
	redirectWww: z.boolean().optional(),
});
export type DomainUpdateInput = z.infer<typeof domainUpdateSchema>;

export interface DomainView {
	id: string;
	projectId: string;
	projectSlug: string;
	hostname: string;
	kind: DomainKind;
	status: DomainStatus;
	/** TXT record name/value the operator (or the Cloudflare integration) must create. */
	verification: { recordName: string; recordValue: string } | null;
	redirectWww: boolean;
	wwwHostname: string | null;
	lastCheckedAt: string | null;
	lastError: string | null;
	createdAt: string;
	verifiedAt: string | null;
}

/** Caddy `ask` request body (`{"domain": "..."}`), answered 200 or 403. */
export const domainAskSchema = z.object({
	domain: z.string().min(1).max(253),
});
export type DomainAsk = z.infer<typeof domainAskSchema>;

export interface DomainCheckResult {
	domain: DomainView;
	/** Human-readable explanation of what is still missing. */
	detail: string;
	/** Records the operator should create, including Cloudflare-suggested targets. */
	records: Array<{ type: 'TXT' | 'CNAME' | 'A' | 'AAAA'; name: string; value: string }>;
}
