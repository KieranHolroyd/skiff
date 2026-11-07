import { describe, expect, test } from 'bun:test';
import { joinArgs, splitArgs } from './job-command';

describe('the job form’s command line', () => {
	test('splits words like a shell, without expanding anything', () => {
		expect(splitArgs('bun scripts/tidy.ts --days 30').args).toEqual(['bun', 'scripts/tidy.ts', '--days', '30']);
		expect(splitArgs(`sh -c 'echo $HOME && ls'`).args).toEqual(['sh', '-c', 'echo $HOME && ls']);
		expect(splitArgs('bun -e "console.log(\\"hi\\")"').args).toEqual(['bun', '-e', 'console.log("hi")']);
		expect(splitArgs(String.raw`ls my\ dir ""`).args).toEqual(['ls', 'my dir', '']);
		expect(splitArgs('  ').args).toEqual([]);
		expect(splitArgs(`echo 'open`).error).toMatch(/single quote/);
	});

	test('joining and splitting round-trip', () => {
		const argv = ['bun', 'tidy.ts', '--older than', "it's", '$HOME'];
		expect(splitArgs(joinArgs(argv)).args).toEqual(argv);
	});
});
