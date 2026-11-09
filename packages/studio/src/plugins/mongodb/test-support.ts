/**
 * Re-exports for the e2e suite under `tests/e2e/studio`: that directory has no package.json of
 * its own, so `mongodb` and `@yoal/contracts` only resolve from inside `packages/studio`.
 */
export { BSON, MongoClient } from 'mongodb';
export { DEFAULT_STUDIO_LIMITS } from '@yoal/contracts';
