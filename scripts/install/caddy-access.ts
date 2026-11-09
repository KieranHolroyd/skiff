/**
 * Caddy must run with the `skiff` supplementary group to read release artifacts from
 * `/var/lib/skiff/agent`. systemd only applies a drop-in to a process it starts, so after writing
 * the drop-in the installer has to inspect the **running** process. `systemctl show
 * -p SupplementaryGroups` reports the unit file, which already lists the group, so checking it
 * skips the restart and leaves a Caddy that cannot read any deployed file: every site answers 403
 * from a node that otherwise looks healthy.
 */

/** Group ids from `/proc/<pid>/status` (`Groups:\t982 983`). */
export function parseProcStatusGroups(status: string): number[] {
	const line = status.split('\n').find((entry) => entry.startsWith('Groups:'));
	if (!line) return [];
	return line
		.slice('Groups:'.length)
		.trim()
		.split(/\s+/)
		.map(Number)
		.filter((id) => Number.isInteger(id) && id > 0);
}

/** The numeric id from a `getent group <name>` line (`skiff:x:982:`), or null. */
export function parseGetentGroupId(output: string): number | null {
	const id = Number(output.trim().split(':')[2]);
	return Number.isInteger(id) && id > 0 ? id : null;
}

/** True when the process whose `/proc/<pid>/status` this is belongs to `gid`. */
export function processHasGroup(status: string, gid: number): boolean {
	if (parseProcStatusGroups(status).includes(gid)) return true;
	// The primary gid is repeated in Groups on Linux; read Gid as well so an older kernel or a
	// hand-written fixture cannot produce a false negative.
	const line = status.split('\n').find((entry) => entry.startsWith('Gid:'));
	if (!line) return false;
	return line
		.slice('Gid:'.length)
		.trim()
		.split(/\s+/)
		.includes(String(gid));
}
