import { dataDir, setupTokenFile } from './config';
import { resolveSetupToken, setupTokenMatches, type SetupToken } from './setup';

let cached: SetupToken | undefined;

/** The install's setup token, resolved once per process (setup.ts explains where it lives). */
export function currentSetupToken(): SetupToken {
	cached ??= resolveSetupToken({ configuredFile: setupTokenFile, dataDir, warn: (message) => console.warn(message) });
	return cached;
}

export function isValidSetupToken(candidate: string | null | undefined): boolean {
	return setupTokenMatches(currentSetupToken().token, candidate);
}
