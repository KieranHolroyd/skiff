/** Minimal interactive prompts. Hidden input is only used for API keys. */
import { createInterface } from 'node:readline/promises';
import { CliError } from './errors.ts';

export async function promptText(question: string, options: { secret?: boolean } = {}): Promise<string> {
	if (!process.stdin.isTTY) {
		const input = await readStdin();
		return (input.split(/\r?\n/, 1)[0] ?? '').trim();
	}
	process.stdout.write(question);
	if (options.secret) return readSecret();
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await readline.question('')).trim();
	} finally {
		readline.close();
	}
}

function readSecret(): Promise<string> {
	const stdin = process.stdin;
	stdin.setRawMode?.(true);
	stdin.resume();
	stdin.setEncoding('utf8');

	return new Promise<string>((resolve, reject) => {
		let value = '';

		const cleanup = () => {
			stdin.setRawMode?.(false);
			stdin.pause();
			stdin.off('data', onData);
		};

		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					cleanup();
					process.stdout.write('\n');
					resolve(value.trim());
					return;
				}
				if (char === '\u0003') {
					cleanup();
					process.stdout.write('\n');
					reject(new CliError('Cancelled.', { code: 'cancelled' }));
					return;
				}
				if (char === '\u007f' || char === '\b') {
					value = value.slice(0, -1);
					continue;
				}
				value += char;
			}
		};

		stdin.on('data', onData);
	});
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * Ask one question on the terminal (prompt on stderr, so stdout stays clean for output).
 * Ctrl-C or Ctrl-D answers with an empty string, which callers treat as "no".
 */
export async function askTerminal(question: string): Promise<string> {
	const readline = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await new Promise<string>((resolve) => {
			readline.once('SIGINT', () => {
				process.stderr.write('\n');
				resolve('');
			});
			readline.once('close', () => resolve(''));
			readline.question(question).then(
				(answer) => resolve(answer.trim()),
				() => resolve(''),
			);
		});
	} finally {
		readline.close();
	}
}

/** Everything piped on stdin, as text. */
export async function readAllStdin(): Promise<string> {
	return readStdin();
}
