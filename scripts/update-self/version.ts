/**
 * Identity of the stage-0 updater.
 *
 * `UPDATER_VERSION` changes when stage-0's own behaviour changes. `UPDATER_BUILD` is injected at
 * compile time (`bun build --compile --define YOAL_UPDATER_BUILD='"<sha>"'`); a source run
 * reports `source`.
 *
 * Failure verdicts are stamped with the identity that produced them. A verdict from a different
 * updater build is not trusted to skip a release: if an updater bug blamed good releases (as on
 * 2026-11-05), installing a fixed updater automatically retries them.
 */
declare const YOAL_UPDATER_BUILD: string | undefined;

export const UPDATER_VERSION = '2.1.0';

/** Oldest release-hook protocol this updater speaks; releases without hooks use the fallback canary. */
export const HOOK_PROTOCOL_MIN = 1;

export const UPDATER_BUILD: string = typeof YOAL_UPDATER_BUILD === 'string' && YOAL_UPDATER_BUILD ? YOAL_UPDATER_BUILD : 'source';

export const UPDATER_IDENTITY = `${UPDATER_VERSION}+${UPDATER_BUILD}`;
