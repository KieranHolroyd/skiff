import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunctionBundle } from './function-bundle.ts';

/**
 * WebAssembly languages (Rust via workers-rs, Go via TinyGo, C/C++, Zig) reach Yoal as an ES module
 * that imports a `.wasm` file. The bundler keeps the wasm as its own CompiledWasm module and rewrites
 * the import to that module's name, which is the layout workerd loads (D121).
 */
const ADD_WASM = Buffer.from(
	'0061736d01000000' + '0107016002' + '7f7f017f' + '03020100' + '070701036164640000' + '0a09010700200020016a0b',
	'hex',
);

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('WebAssembly Workers', () => {
	test('a JS entry importing .wasm bundles to an esm module plus a wasm module', async () => {
		const root = await mkdtemp(join(tmpdir(), 'yoal-wasm-'));
		dirs.push(root);
		await mkdir(join(root, 'build'), { recursive: true });
		await writeFile(join(root, 'build', 'add.wasm'), ADD_WASM);
		await writeFile(
			join(root, 'build', 'index.js'),
			'import mod from "./add.wasm";\nconst add = new WebAssembly.Instance(mod).exports.add;\nexport default { fetch: () => new Response(String(add(2, 3))) };\n',
		);
		await writeFile(
			join(root, 'wrangler.json'),
			JSON.stringify({ name: 'wasm', main: 'build/index.js', compatibility_date: '2026-10-01' }),
		);

		const built = await buildFunctionBundle({ config: { path: join(root, 'wrangler.json') } as never });
		try {
			const types = built.manifest.modules.map((module) => module.type).sort();
			expect(types).toEqual(['esm', 'wasm']);
			const wasm = built.manifest.modules.find((module) => module.type === 'wasm')!;
			expect(wasm.name.endsWith('add.wasm')).toBe(true);
			const main = await readFile(join(built.dir, built.manifest.main), 'utf8');
			expect(main).toContain(wasm.name);
			expect(Buffer.compare(await readFile(join(built.dir, wasm.name)), ADD_WASM)).toBe(0);
		} finally {
			await built.cleanup();
		}
	});
});
