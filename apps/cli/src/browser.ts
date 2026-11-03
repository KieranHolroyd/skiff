/** Open a URL in the user's browser without depending on a platform-specific package. */
import { spawn } from 'node:child_process';

export function openExternal(url: string): Promise<boolean> {
	const [command, ...args] =
		process.platform === 'darwin'
			? ['open', url]
			: process.platform === 'win32'
				? ['cmd', '/c', 'start', '', url]
				: ['xdg-open', url];
	return new Promise((resolve) => {
		try {
			const child = spawn(command!, args, { stdio: 'ignore' });
			child.once('error', () => resolve(false));
			child.once('exit', (code) => resolve(code === 0));
		} catch {
			resolve(false);
		}
	});
}
