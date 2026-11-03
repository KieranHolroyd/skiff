import { parseSemver } from '@skiff/contracts';

/** The running platform's semantic version (repository-root `VERSION`, baked in at build time). */
export const platformVersion: string = parseSemver(__SKIFF_VERSION__)?.version ?? __SKIFF_VERSION__;
