import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	PLATFORM_CONFIG_SECTIONS,
	applyPlatformConfig,
	type PlatformConfigRequest
} from '@skiff/contracts';

/**
 * Settings → Backups / Notifications on a local dev server (no installed release, no root helper).
 * Saved values go to `<SKIFF_DATA_DIR>/platform-settings.json` (gitignored `.data/`), which
 * `config.ts` loads into the environment at startup, so a dev-server restart applies them. Never
 * used in production, where `/etc/skiff/skiff.env` and `skiff-platform-config` are the only path.
 */

export const localSettingsEnabled = process.env.NODE_ENV !== 'production';

const ALLOWED: ReadonlySet<string> = new Set(Object.values(PLATFORM_CONFIG_SECTIONS).flat());

/** When this process loaded its settings; a newer file means a restart is needed. */
const startedAt = Date.now();

export function localSettingsPath(env: Record<string, string | undefined> = process.env): string {
	return join(env.SKIFF_DATA_DIR ?? '.data', 'platform-settings.json');
}

/** `null` = explicitly removed (overrides the shell environment). */
type Overlay = Record<string, string | null>;

function readOverlay(path: string): Overlay {
	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const overlay: Overlay = {};
		for (const [key, value] of Object.entries(raw))
			if (ALLOWED.has(key) && (typeof value === 'string' || value === null)) overlay[key] = value;
		return overlay;
	} catch {
		return {};
	}
}

/** Called by config.ts before it reads anything. */
export function loadLocalSettings(env: Record<string, string | undefined> = process.env): void {
	if (!localSettingsEnabled) return;
	for (const [key, value] of Object.entries(readOverlay(localSettingsPath(env)))) {
		if (value === null) delete env[key];
		else env[key] = value;
	}
}

/**
 * Apply a validated configure request to the local file and to this process's environment (so the
 * page shows it straight away). Returns the changed keys. Throws on an incomplete section.
 */
export function saveLocalSettings(
	request: Extract<PlatformConfigRequest, { action: 'configure' }>,
	env: Record<string, string | undefined> = process.env
): string[] {
	const keys = PLATFORM_CONFIG_SECTIONS[request.section];
	const current = new Map<string, string>();
	for (const key of keys) if (env[key]) current.set(key, env[key]!);
	const changed = applyPlatformConfig(current, request);
	if (changed.length === 0) return changed;

	const path = localSettingsPath(env);
	const overlay = readOverlay(path);
	for (const key of keys) {
		overlay[key] = current.get(key) ?? null;
		if (current.has(key)) env[key] = current.get(key);
		else delete env[key];
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
	return changed;
}

/** Saved after this server started, so its email/alert/R2 clients still use the old values. */
export function localRestartPending(
	env: Record<string, string | undefined> = process.env
): boolean {
	const path = localSettingsPath(env);
	if (!localSettingsEnabled || !existsSync(path)) return false;
	return statSync(path).mtimeMs > startedAt;
}
