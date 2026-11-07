import { resolveTxt } from 'node:dns/promises';

/** A TXT character-string holds at most 255 bytes; longer values are split into several. */
const MAX_TXT_STRING = 255;

/**
 * Put TXT records back together when the runtime flattened them.
 *
 * Node returns one array per record, holding that record's character-strings in order. Bun (1.4)
 * returns every character-string as its own record, so a 2048-bit DKIM key published as
 * `"…255 chars…" "rest"` arrives as two records and no single value carries the whole `p=`.
 * Publishers split at exactly 255, so when every record is a single string, a 255-long string is
 * joined to the one after it. Output that is already grouped is returned untouched.
 */
export function regroupTxtRecords(records: string[][]): string[][] {
	if (records.some((record) => record.length !== 1)) return records;
	const grouped: string[][] = [];
	let continuing = false;
	for (const [value] of records) {
		if (continuing) grouped.at(-1)!.push(value!);
		else grouped.push([value!]);
		continuing = Buffer.byteLength(value!) === MAX_TXT_STRING;
	}
	return grouped;
}

/** `resolveTxt` from the system resolver, regrouped so every runtime returns one entry per record. */
export async function resolveTxtRecords(name: string): Promise<string[][]> {
	return regroupTxtRecords(await resolveTxt(name));
}
