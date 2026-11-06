/**
 * A tiny, deterministic argument parser (no dependencies).
 *
 * Supports `--flag`, `--no-flag` for booleans, `--name value`, `--name=value`,
 * short aliases (`-h`), and `--` to stop flag parsing.
 */
import { UsageError } from './errors.ts';

export { UsageError };

export type FlagDef =
	| { type: 'boolean'; short?: string; default?: boolean; description?: string }
	| { type: 'string'; short?: string; default?: string; description?: string; multiple?: boolean };

export type FlagSpec = Record<string, FlagDef>;

export class ParsedArgs {
	readonly positionals: string[];
	private readonly values: Map<string, string | boolean>;
	private readonly lists: Map<string, string[]>;

	constructor(positionals: string[], values: Map<string, string | boolean>, lists = new Map<string, string[]>()) {
		this.positionals = positionals;
		this.values = values;
		this.lists = lists;
	}

	has(name: string): boolean {
		return this.values.has(name);
	}

	string(name: string): string | undefined {
		const value = this.values.get(name);
		return typeof value === 'string' ? value : undefined;
	}

	boolean(name: string): boolean {
		const value = this.values.get(name);
		return value === true;
	}

	/** Every value of a `multiple` string option, in order (`string()` returns the last). */
	strings(name: string): string[] {
		return [...(this.lists.get(name) ?? [])];
	}
}

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
	const values = new Map<string, string | boolean>();
	const lists = new Map<string, string[]>();
	const aliases = new Map<string, string>();
	const setString = (name: string, value: string) => {
		values.set(name, value);
		if (spec[name]?.type === 'string' && spec[name].multiple) lists.set(name, [...(lists.get(name) ?? []), value]);
	};
	for (const [name, def] of Object.entries(spec)) {
		if (def.default !== undefined) values.set(name, def.default);
		if (def.short) aliases.set(def.short, name);
	}

	const positionals: string[] = [];
	let flagsDone = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (flagsDone) {
			positionals.push(token);
			continue;
		}
		if (token === '--') {
			flagsDone = true;
			continue;
		}
		if (!token.startsWith('-') || token === '-') {
			positionals.push(token);
			continue;
		}

		if (token.startsWith('--')) {
			const raw = token.slice(2);
			const equals = raw.indexOf('=');
			const namePart = equals === -1 ? raw : raw.slice(0, equals);
			const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1);
			// A flag may be declared under its literal name ("no-wrangler") alongside a different
			// flag it looks like a negation of ("wrangler"), so the literal name wins.
			const literal = spec[namePart];
			const negated = literal === undefined && namePart.startsWith('no-');
			const name = negated ? namePart.slice(3) : namePart;
			const def = literal ?? spec[name];
			if (!def) throw new UsageError(`Unknown option --${namePart}.`);

			if (def.type === 'boolean') {
				if (inlineValue !== undefined) {
					values.set(name, parseBoolean(inlineValue, `--${namePart}`));
				} else {
					values.set(name, !negated);
				}
				continue;
			}

			if (negated) throw new UsageError(`--no-${name} is only valid for boolean options.`);
			if (inlineValue !== undefined) {
				setString(name, inlineValue);
				continue;
			}
			const next = argv[i + 1];
			if (next === undefined) throw new UsageError(`Option --${name} needs a value.`);
			setString(name, next);
			i++;
			continue;
		}

		// Short option, with an optional attached value like `-pfoo`.
		const short = token.slice(1);
		const name = aliases.get(short[0] ?? '');
		if (!name) throw new UsageError(`Unknown option -${short[0] ?? short}.`);
		const def = spec[name]!;
		const rest = short.slice(1);
		if (def.type === 'boolean') {
			if (rest) throw new UsageError(`Unknown option -${short}.`);
			values.set(name, true);
			continue;
		}
		if (rest) {
			setString(name, rest.startsWith('=') ? rest.slice(1) : rest);
			continue;
		}
		const next = argv[i + 1];
		if (next === undefined) throw new UsageError(`Option -${short} needs a value.`);
		setString(name, next);
		i++;
	}

	return new ParsedArgs(positionals, values, lists);
}

function parseBoolean(value: string, flag: string): boolean {
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	throw new UsageError(`${flag} expects true or false.`);
}

export function requirePositional(args: ParsedArgs, index: number, name: string): string {
	const value = args.positionals[index];
	if (!value) throw new UsageError(`Missing ${name}.`);
	return value;
}

export function rejectExtraPositionals(args: ParsedArgs, max: number, usage: string): void {
	if (args.positionals.length > max) throw new UsageError(`Too many arguments.\n\n${usage}`);
}

/** Build a `--flag` -> help line from a spec. */
export function formatFlagHelp(spec: FlagSpec): string {
	return Object.entries(spec)
		.filter(([, def]) => def.type === 'string')
		.map(([name, def]) => {
			const short = def.short ? `-${def.short}, ` : '    ';
			return `  ${short}--${name}${'value' in def && def.type === 'string' ? ' <value>' : ''}`;
		})
		.join('\n');
}
