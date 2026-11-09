/**
 * The static identity units (docs/IAM.md §11.2). The identity process is one per install for now:
 * the node's agent starts `skiff-identity.service` through the helper's fixed verb, and the
 * companion Litestream unit follows it. Neither unit is enabled at boot, so a node that is not the
 * identity node never runs them.
 */
export const IDENTITY_UNIT = 'skiff-identity.service';
export const IDENTITY_LITESTREAM_UNIT = 'skiff-litestream-identity.service';
