#!/usr/bin/env bun
/**
 * Test double for `systemd-creds` (tests only; never installed). Implements the four verbs
 * master-key.ts uses with the same argument shapes and exit codes:
 *
 *   --version                                         prints "systemd <FAKE_CREDS_VERSION|257> ..."
 *   has-tpm2                                          exit 0 when FAKE_CREDS_TPM2=1, else 1 ("partial")
 *   encrypt --name=N --with-key=K [--tpm2-pcrs=] - OUT
 *   decrypt --name=N IN -
 *
 * An encrypted file is `FAKECRED name=<N> key=<K> host=<H>\n` followed by base64 of the input.
 * Decryption fails unless the name matches and FAKE_CREDS_HOST (default "host-a") is the host
 * that encrypted it, which stands in for "only opens on the machine that sealed it".
 *
 * Knobs (environment): FAKE_CREDS_TPM2_FAIL=1 makes TPM2 encryption fail, FAKE_CREDS_FAIL=1
 * makes every encryption fail, FAKE_CREDS_CORRUPT=1 makes decrypt return other bytes, and
 * FAKE_CREDS_LOG=<file> appends each argv as a JSON line.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

function main(): void {
	const env = process.env;
	const args = process.argv.slice(2);
	const host = env.FAKE_CREDS_HOST || 'host-a';
	const HEADER = 'FAKECRED';

	if (env.FAKE_CREDS_LOG) appendFileSync(env.FAKE_CREDS_LOG, `${JSON.stringify(args)}\n`);

	function fail(message: string, code = 1): never {
		process.stderr.write(`${message}\n`);
		process.exit(code);
	}

	function option(name: string): string | undefined {
		const prefix = `--${name}=`;
		return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
	}

	const positional = args.filter((arg) => !arg.startsWith('--'));
	const verb = args[0] === '--version' ? '--version' : positional[0];

	switch (verb) {
		case '--version':
			process.stdout.write(`systemd ${env.FAKE_CREDS_VERSION || '257'} (${env.FAKE_CREDS_VERSION || '257'}.9-1~deb13u1)\n+PAM +AUDIT +TPM2\n`);
			break;
		case 'has-tpm2':
			if (env.FAKE_CREDS_TPM2 === '1') process.stdout.write('yes\n+firmware\n+driver\n+system\n+subsystem\n+libraries\n');
			else {
				process.stdout.write('partial\n-firmware\n-driver\n+system\n+subsystem\n+libraries\n');
				process.exit(1);
			}
			break;
		case 'encrypt': {
			const name = option('name');
			const key = option('with-key');
			const [, input, output] = positional;
			if (!name || !key || input !== '-' || !output) fail('fake systemd-creds: usage: encrypt --name=N --with-key=K - OUT', 2);
			if (env.FAKE_CREDS_FAIL === '1') fail('Failed to determine local credential host secret: Permission denied');
			if (key.includes('tpm2')) {
				if (env.FAKE_CREDS_TPM2 !== '1' || env.FAKE_CREDS_TPM2_FAIL === '1') fail('Failed to find TPM2 device: No such device');
				if (option('tpm2-pcrs') === undefined) fail('fake systemd-creds: a TPM2 seal must name its PCRs (empty for none)', 2);
			}
			const plaintext = readFileSync(0);
			writeFileSync(output, `${HEADER} name=${name} key=${key} host=${host}\n${plaintext.toString('base64')}\n`);
			break;
		}
		case 'decrypt': {
			const name = option('name');
			const [, input, output] = positional;
			if (!name || !input || output !== '-') fail('fake systemd-creds: usage: decrypt --name=N IN -', 2);
			let content: string;
			try {
				content = readFileSync(input, 'utf8');
			} catch (error) {
				fail(`Failed to read ${input}: ${(error as Error).message}`);
			}
			const [header = '', body = ''] = content.split('\n');
			const fields = Object.fromEntries(
				header
					.split(' ')
					.slice(1)
					.map((part) => part.split('=') as [string, string]),
			);
			if (!header.startsWith(`${HEADER} `)) fail('Failed to decrypt credential: Bad message');
			if (fields.name !== name) fail(`Embedded credential name '${fields.name}' does not match filename '${name}', refusing.`);
			if (fields.host !== host) fail('Failed to decrypt credential: Bad message (host key mismatch)');
			const plaintext = Buffer.from(body, 'base64');
			process.stdout.write(env.FAKE_CREDS_CORRUPT === '1' ? Buffer.concat([plaintext, Buffer.from('x')]) : plaintext);
			break;
		}
		default:
			fail(`fake systemd-creds: unknown verb '${verb ?? ''}'`, 2);
	}
}

if (import.meta.main) main();

/** Wrapper script for tests: a `systemd-creds` binary path running this fake with `env` set. */
export function fakeCredsBinary(dir: string, env: Record<string, string> = {}): string {
	const path = `${dir}/systemd-creds`;
	const exports = Object.entries(env)
		.map(([key, value]) => `export ${key}='${value.replace(/'/g, `'\\''`)}'\n`)
		.join('');
	writeFileSync(path, `#!/bin/sh\n${exports}exec '${process.execPath}' '${import.meta.path}' "$@"\n`, { mode: 0o755 });
	return path;
}
