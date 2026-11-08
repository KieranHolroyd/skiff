/**
 * Secret masking for job logs (W11). Every secret value, its base64 and URL-encoded forms, and
 * every `::add-mask::` value become `***` in every line before the line leaves the step runner.
 *
 * Masking works line by line, so a multi-line secret is registered as each of its lines: a
 * certificate printed whole is still hidden, line for line. Values are matched longest first so a
 * secret that contains another secret is hidden entirely rather than leaving a fragment.
 */
export class Masker {
	private readonly values = new Set<string>();
	private pattern: RegExp | null = null;
	private dirty = false;

	/** Register a secret (all of its encodings and lines). Empty and blank values are ignored. */
	add(value: string | null | undefined): void {
		if (!value) return;
		const candidates = new Set<string>([value]);
		for (const line of value.split(/\r?\n/)) candidates.add(line);
		for (const candidate of [...candidates]) {
			if (!candidate.trim()) continue;
			this.addOne(candidate);
			const base64 = Buffer.from(candidate, 'utf8').toString('base64');
			this.addOne(base64);
			// A secret embedded in a longer base64 blob loses its padding.
			this.addOne(base64.replace(/=+$/, ''));
			this.addOne(encodeURIComponent(candidate));
		}
	}

	addAll(values: Iterable<string>): void {
		for (const value of values) this.add(value);
	}

	private addOne(value: string): void {
		// A blank value would turn every gap in the log into `***`.
		if (!value.trim() || value.includes('\n') || this.values.has(value)) return;
		this.values.add(value);
		this.dirty = true;
	}

	get size(): number {
		return this.values.size;
	}

	/** True when `text` contains any registered value (used to drop secret-bearing job outputs). */
	contains(text: string): boolean {
		return this.mask(text) !== text;
	}

	mask(text: string): string {
		if (!this.values.size || !text) return text;
		if (this.dirty || !this.pattern) {
			const sorted = [...this.values].sort((a, b) => b.length - a.length);
			this.pattern = new RegExp(sorted.map(escapeRegExp).join('|'), 'g');
			this.dirty = false;
		}
		return text.replace(this.pattern, '***');
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
