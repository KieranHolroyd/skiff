/**
 * The two ways a step talks back to the runner, parsed exactly like GitHub's runner so existing
 * scripts work unchanged:
 *
 * - file commands: `$SKIFF_OUTPUT`/`$GITHUB_OUTPUT`, `$SKIFF_ENV`/`$GITHUB_ENV` (`name=value` or
 *   the heredoc form `name<<DELIMITER`), and `$SKIFF_PATH`/`$GITHUB_PATH` (one directory per line);
 * - workflow commands on stdout/stderr: `::add-mask::`, `::set-output name=x::`, `::group::`,
 *   `::error file=…::`, `::stop-commands::<token>` … `::<token>::`.
 */

export class FileCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'FileCommandError';
	}
}

/**
 * Parse a `$GITHUB_OUTPUT`/`$GITHUB_ENV` file. Later assignments win. A heredoc's value is every
 * line up to (not including) the delimiter line; a missing delimiter is an error, as on GitHub.
 */
export function parseKeyValueFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	if (!content) return result;
	const lines = content.split(/\r?\n/);
	// A trailing newline yields one empty last element, which is not a line.
	if (lines.at(-1) === '') lines.pop();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (!line.trim()) continue;
		const equals = line.indexOf('=');
		const heredoc = line.indexOf('<<');
		// GitHub picks whichever separator comes first.
		if (heredoc >= 0 && (equals < 0 || heredoc < equals)) {
			const name = line.slice(0, heredoc);
			const delimiter = line.slice(heredoc + 2);
			if (!name) throw new FileCommandError(`Invalid format "${line.slice(0, 100)}": name must not be empty`);
			if (!delimiter) throw new FileCommandError(`Invalid format "${line.slice(0, 100)}": delimiter must not be empty`);
			const body: string[] = [];
			let closed = false;
			for (index += 1; index < lines.length; index += 1) {
				if (lines[index] === delimiter) {
					closed = true;
					break;
				}
				body.push(lines[index]!);
			}
			if (!closed) throw new FileCommandError(`Matching delimiter not found "${delimiter.slice(0, 100)}"`);
			result[name] = body.join('\n');
			continue;
		}
		if (equals < 0) throw new FileCommandError(`Invalid format "${line.slice(0, 100)}"`);
		const name = line.slice(0, equals);
		if (!name) throw new FileCommandError(`Invalid format "${line.slice(0, 100)}": name must not be empty`);
		result[name] = line.slice(equals + 1);
	}
	return result;
}

/** `$GITHUB_PATH`: one directory per line, blank lines ignored, in file order. */
export function parsePathFile(content: string): string[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Variables a step may not set through `$SKIFF_ENV` (GitHub refuses `NODE_OPTIONS` the same way). */
export const PROTECTED_ENV_NAMES = new Set(['NODE_OPTIONS', 'SKIFF_JOB_TOKEN', 'SKIFF_CONTROL_URL']);

// --- workflow commands -----------------------------------------------------------------

export interface WorkflowCommand {
	command: string;
	properties: Record<string, string>;
	data: string;
}

function unescapeData(value: string): string {
	return value.replace(/%0D/gi, '\r').replace(/%0A/gi, '\n').replace(/%25/g, '%');
}

function unescapeProperty(value: string): string {
	return value
		.replace(/%0D/gi, '\r')
		.replace(/%0A/gi, '\n')
		.replace(/%3A/gi, ':')
		.replace(/%2C/gi, ',')
		.replace(/%25/g, '%');
}

/** Parse `::command key=value,key2=value::data`; null when the line is not a command. */
export function parseWorkflowCommand(line: string): WorkflowCommand | null {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith('::')) return null;
	const end = trimmed.indexOf('::', 2);
	if (end < 0) return null;
	const head = trimmed.slice(2, end);
	const data = trimmed.slice(end + 2);
	const space = head.indexOf(' ');
	const command = space < 0 ? head : head.slice(0, space);
	if (!command || !/^[A-Za-z0-9_-]+$/.test(command)) return null;
	const properties: Record<string, string> = {};
	if (space >= 0) {
		for (const pair of head.slice(space + 1).split(',')) {
			const equals = pair.indexOf('=');
			if (equals <= 0) continue;
			properties[pair.slice(0, equals).trim()] = unescapeProperty(pair.slice(equals + 1));
		}
	}
	return { command, properties, data: unescapeData(data) };
}

/** What the runner should do with one output line. */
export type CommandEffect =
	| { kind: 'mask'; value: string }
	| { kind: 'output'; name: string; value: string }
	| { kind: 'warning'; message: string };

/**
 * Stateful per-step processor: tracks `::stop-commands::`. Returns the line to log (null to drop
 * it) and any effect for the runner to apply.
 */
export class WorkflowCommandProcessor {
	private stopToken: string | null = null;

	process(line: string): { line: string | null; effect: CommandEffect | null } {
		const parsed = parseWorkflowCommand(line);
		if (this.stopToken !== null) {
			if (parsed && parsed.command === this.stopToken) {
				this.stopToken = null;
				return { line: null, effect: null };
			}
			return { line, effect: null };
		}
		if (!parsed) return { line, effect: null };
		switch (parsed.command) {
			case 'add-mask':
				// The value never reaches the log, not even masked.
				return { line: null, effect: parsed.data ? { kind: 'mask', value: parsed.data } : null };
			case 'stop-commands':
				if (!parsed.data) return { line, effect: null };
				this.stopToken = parsed.data;
				return { line: null, effect: null };
			case 'set-output': {
				const name = parsed.properties.name;
				if (!name) return { line, effect: { kind: 'warning', message: 'set-output needs a name property' } };
				return { line: null, effect: { kind: 'output', name, value: parsed.data } };
			}
			case 'set-env':
			case 'add-path':
				return {
					line,
					effect: {
						kind: 'warning',
						message: `The \`${parsed.command}\` command is disabled; use $SKIFF_ENV / $SKIFF_PATH (or the GITHUB_ names)`,
					},
				};
			case 'save-state':
			case 'echo':
				return { line: null, effect: null };
			default:
				// group/endgroup/error/warning/notice/debug stay in the log for the viewer to render.
				return { line, effect: null };
		}
	}
}
