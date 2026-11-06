import { and, eq, isNull } from 'drizzle-orm';
import { storageAttachments, storageInstances } from '@skiff/db';
import type { FunctionRuntimeBinding, StorageGrant } from '@skiff/contracts';
import { ValidationError } from '../errors.ts';
import type { BindingResolveContext, BindingResolver } from './types.ts';

/**
 * R2 (docs/FUNCTIONS.md §4.5, D66, FN10): an `r2Bucket` binding backed by a managed RustFS instance.
 *
 * The control plane proves the instance exists in the caller's org, is RustFS, and is attached to
 * this project with a grant that covers the bucket. Those checks are what make the binding safe to
 * render: the attachment is what puts `<PREFIX>_ENDPOINT_URL`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY`
 * into the workload's activation env (D66), and the scoped key only grants the attachment's
 * buckets. No credential or endpoint is stored in the resolved spec, so desired state stays secret
 * free and a redeploy is not needed when the attachment rotates its key.
 */
export const resolveR2Binding: BindingResolver = (context, binding) => {
	if (binding.type !== 'r2') {
		throw new Error(
			`R2 resolver received binding "${binding.name}" of type "${binding.type}", not "r2".`,
		);
	}

	const instance = context.core.db
		.select()
		.from(storageInstances)
		.where(
			and(
				eq(storageInstances.orgId, context.project.orgId),
				eq(storageInstances.name, binding.storage),
				isNull(storageInstances.deletedAt),
			),
		)
		.get();
	if (!instance)
		throw new ValidationError(
			`Binding ${binding.name}: storage instance "${binding.storage}" does not exist in this organisation.`,
		);
	if (instance.engine !== 'rustfs')
		throw new ValidationError(
			`Binding ${binding.name}: storage instance "${binding.storage}" is not RustFS and cannot back an R2 binding.`,
		);

	// The attachment is what the node turns into `<PREFIX>_*` activation env, so it is required
	// even though the instance itself is an org resource.
	const attachment = context.core.db
		.select()
		.from(storageAttachments)
		.where(
			and(
				eq(storageAttachments.storageId, instance.id),
				eq(storageAttachments.projectId, context.project.id),
			),
		)
		.get();
	if (!attachment)
		throw new ValidationError(
			`Binding ${binding.name}: attach storage "${binding.storage}" to this project before using it as an R2 binding.`,
		);

	const grants = parseGrants(attachment.grantsJson);
	if (!grants.some((grant) => grant.bucket === binding.bucket || grant.bucket === '*'))
		throw new ValidationError(
			`Binding ${binding.name}: the storage attachment does not grant bucket "${binding.bucket}".`,
		);

	return {
		name: binding.name,
		type: 'r2',
		storage: binding.storage,
		bucket: binding.bucket,
		...(binding.prefix !== undefined ? { prefix: binding.prefix } : {}),
		envPrefix: attachment.envPrefix || 'S3',
	} satisfies FunctionRuntimeBinding;
};

/**
 * `grants_json` is stored shape-validated by the storage service, but a legacy or hand-edited row
 * must not crash a deploy: keep the bucket names and ignore anything malformed.
 */
function parseGrants(json: string): StorageGrant[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(grant): grant is StorageGrant =>
			typeof grant === 'object' && grant !== null && typeof (grant as { bucket?: unknown }).bucket === 'string',
	);
}
