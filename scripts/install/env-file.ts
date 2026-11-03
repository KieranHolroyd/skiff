/**
 * `/etc/skiff/skiff.env` reader/writer shared by the installer and `skiff-update-self`.
 *
 * The file is a systemd `EnvironmentFile=`. Values made only of shell-safe characters are written
 * bare; anything else (spaces, `<`, `$`, quotes, backslashes, …) is double-quoted with systemd's
 * escapes (`\"`, `\\`, `` \` ``, `\$`), so e.g. `SKIFF_SMTP_FROM=Skiff <noreply@…>` or an SMTP
 * password with `;` round-trips through systemd and through the shell parsers in
 * `scripts/restore.sh` / `scripts/skiff-restore-drill.sh` (which never `.`-source the file).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const SAFE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/** One `KEY=value` line in systemd EnvironmentFile syntax. */
export function formatEnvLine(key: string, value: string): string {
	if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain a newline`);
	if (SAFE.test(value)) return `${key}=${value}`;
	return `${key}="${value.replace(/["\\`$]/g, (c) => `\\${c}`)}"`;
}

/** Inverse of formatEnvLine; also accepts single-quoted and legacy bare values. */
export function parseEnvValue(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
		return value.slice(1, -1).replace(/\\(["\\`$])/g, '$1');
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return value;
}

export function parseEnvFile(text: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const index = line.indexOf('=');
		if (index <= 0) continue;
		map.set(line.slice(0, index).trim(), parseEnvValue(line.slice(index + 1)));
	}
	return map;
}

export function readEnvFile(path: string): Map<string, string> {
	return existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : new Map();
}

export function formatEnvFile(map: Map<string, string>, sort = true): string {
	const entries = [...map.entries()];
	if (sort) entries.sort(([a], [b]) => a.localeCompare(b));
	return `${entries.map(([key, value]) => formatEnvLine(key, value)).join('\n')}\n`;
}

/** Atomic write (temp file + rename) with the given mode. */
export function writeEnvFile(path: string, map: Map<string, string>, mode = 0o640): void {
	writeFileSync(`${path}.tmp`, formatEnvFile(map), { mode });
	renameSync(`${path}.tmp`, path);
}
