import { loadIdentityConfig } from './config.ts';
import { createIdentityRuntime } from './service.ts';

/**
 * Entry point for `yoal-agent identity`, run by `yoal-identity.service` in its own cgroup
 * (docs/IAM.md §11.2). Like `yoal-mail`, it reads no agent config and never sees the node token.
 */
export async function runIdentityProcess(): Promise<void> {
	const config = loadIdentityConfig();
	const runtime = await createIdentityRuntime(config, {
		version: process.env.YOAL_IDENTITY_VERSION?.trim() || process.env.YOAL_AGENT_VERSION?.trim() || 'dev',
		log: (level, message) => {
			const line = `[yoal-identity ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
			if (level === 'error') console.error(line);
			else if (level === 'warn') console.warn(line);
			else console.log(line);
		},
	});
	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		runtime.stop().finally(() => process.exit(0));
	};
	signals.once('SIGTERM', stop);
	signals.once('SIGINT', stop);
	// Keep the process alive until a signal arrives.
	await new Promise<void>(() => undefined);
}
