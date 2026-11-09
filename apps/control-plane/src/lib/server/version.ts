import { parseSemver } from '@yoal/contracts';

/** The running platform's semantic version (repository-root `VERSION`, baked in at build time). */
export const platformVersion: string = parseSemver(__YOAL_VERSION__)?.version ?? __YOAL_VERSION__;
