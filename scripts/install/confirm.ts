/**
 * An interactive yes/no prompt for the installer: `Question  › Yes / No`, toggled with ←/→, Tab,
 * h/l or y/n, confirmed with Enter (y and n confirm at once). Ctrl-C aborts the install.
 *
 * The key handling is a pure function so it can be tested without a terminal; `confirm` drives it
 * on a raw-mode TTY and falls back to a typed y/n answer when raw mode is unavailable.
 */
import { emitKeypressEvents } from 'node:readline';

export interface ConfirmKey {
	name?: string;
	sequence?: string;
	ctrl?: boolean;
}

export type ConfirmStep =
	| { kind: 'select'; value: boolean }
	| { kind: 'done'; value: boolean }
	| { kind: 'abort' }
	| { kind: 'ignore' };

/** What one keypress does to a prompt currently showing `value`. */
export function confirmStep(value: boolean, key: ConfirmKey): ConfirmStep {
	if (key.ctrl && (key.name === 'c' || key.name === 'd')) return { kind: 'abort' };
	switch (key.name) {
		case 'return':
		case 'enter':
			return { kind: 'done', value };
		case 'y':
			return { kind: 'done', value: true };
		case 'n':
			return { kind: 'done', value: false };
		case 'left':
		case 'right':
		case 'up':
		case 'down':
		case 'tab':
		case 'h':
		case 'l':
		case 'space':
			return { kind: 'select', value: !value };
		case 'escape':
			return { kind: 'done', value: false };
		default:
			return { kind: 'ignore' };
	}
}

const style = {
	selected: (s: string) => `\x1b[1;36m\x1b[4m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** The prompt line for `value` (exported for tests). */
export function renderConfirm(question: string, value: boolean): string {
	const yes = value ? style.selected('Yes') : style.dim('Yes');
	const no = value ? style.dim('No') : style.selected('No');
	return `${style.bold('?')} ${question} ${style.dim('›')} ${yes} ${style.dim('/')} ${no}  ${style.dim('(←/→, enter)')}`;
}

export interface ConfirmIo {
	input: NodeJS.ReadStream;
	output: NodeJS.WriteStream;
	/** Typed fallback when the input cannot enter raw mode. */
	ask: (question: string, fallback: string) => Promise<string>;
}

/**
 * Ask a yes/no question. `initial` is the highlighted answer (and the typed fallback's default).
 * Callers pause any readline interface on the same input first.
 */
export async function confirm(question: string, initial: boolean, io: ConfirmIo): Promise<boolean> {
	const { input, output } = io;
	if (!input.isTTY || typeof input.setRawMode !== 'function') {
		const answer = (await io.ask(`${question} (${initial ? 'Y/n' : 'y/N'})`, initial ? 'y' : 'n')).trim().toLowerCase();
		return answer === '' ? initial : answer === 'y' || answer === 'yes';
	}

	emitKeypressEvents(input);
	const wasRaw = input.isRaw;
	input.setRawMode(true);
	input.resume();
	let value = initial;
	let answered = false;
	const draw = () => output.write(`\r\x1b[2K${renderConfirm(question, value)}`);
	output.write('\x1b[?25l'); // hide the cursor while the toggle is shown
	draw();

	try {
		return await new Promise<boolean>((resolve, reject) => {
			const onKey = (_: string, key: ConfirmKey | undefined) => {
				const step = confirmStep(value, key ?? {});
				if (step.kind === 'ignore') return;
				if (step.kind === 'abort') {
					input.off('keypress', onKey);
					reject(new Error('Installation cancelled.'));
					return;
				}
				value = step.value;
				draw();
				if (step.kind === 'done') {
					input.off('keypress', onKey);
					answered = true;
					resolve(value);
				}
			};
			input.on('keypress', onKey);
		});
	} finally {
		input.setRawMode(wasRaw ?? false);
		const result = answered ? style.green(value ? 'Yes' : 'No') : style.dim('cancelled');
		output.write(`\r\x1b[2K${style.bold('?')} ${question} ${style.dim('›')} ${result}\n\x1b[?25h`);
	}
}
