import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildValidationError } from './command.ts';
import { insideCheckout } from './runner.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-runner-'));
const checkout = join(root, 'checkout');
mkdirSync(join(checkout, 'apps', 'web', 'dist'), { recursive: true });
mkdirSync(join(root, 'outside'));
symlinkSync(join(root, 'outside'), join(checkout, 'escape'));
symlinkSync('apps/web/dist', join(checkout, 'linked-dist'));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('insideCheckout', () => {
	test('accepts paths (and symlinks) that stay in the checkout', async () => {
		expect(await insideCheckout(checkout, join(checkout, 'apps', 'web'), 'rootDir')).toEndWith('/apps/web');
		expect(await insideCheckout(checkout, join(checkout, 'linked-dist'), 'outputDir')).toEndWith('/apps/web/dist');
		expect(await insideCheckout(checkout, checkout, 'rootDir')).toEndWith('/checkout');
	});

	test('rejects a symlink that leaves the checkout, and a missing directory', async () => {
		await expect(insideCheckout(checkout, join(checkout, 'escape'), 'outputDir')).rejects.toThrow(/outside/);
		await expect(insideCheckout(checkout, join(checkout, 'missing'), 'outputDir')).rejects.toBeInstanceOf(
			BuildValidationError,
		);
	});
});
