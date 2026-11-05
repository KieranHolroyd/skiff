import { describe, expect, test } from 'bun:test';
import { folderKey, fromFileList, uploadKey } from './picked.ts';

function file(name: string, relative = ''): File {
	const value = new File(['x'], name);
	if (relative) Object.defineProperty(value, 'webkitRelativePath', { value: relative });
	return value;
}

describe('uploadKey', () => {
	test('keeps a dropped tree under the current prefix', () => {
		expect(uploadKey('', 'a.txt')).toBe('a.txt');
		expect(uploadKey('docs/', 'photos/2026/a.jpg')).toBe('docs/photos/2026/a.jpg');
	});

	test('drops empty, dot and dot-dot segments and normalises backslashes', () => {
		expect(uploadKey('x/', '/photos//./../a.jpg')).toBe('x/photos/a.jpg');
		expect(uploadKey('', 'win\\dir\\b.txt')).toBe('win/dir/b.txt');
		expect(uploadKey('x/', '..')).toBe('x/');
	});
});

describe('folderKey', () => {
	test('ends in a slash, or is empty when nothing is left', () => {
		expect(folderKey('docs/', 'photos/empty')).toBe('docs/photos/empty/');
		expect(folderKey('docs/', '.')).toBe('');
	});
});

describe('fromFileList', () => {
	test('uses the folder-relative path when the picker gives one', () => {
		const picked = fromFileList([file('a.jpg', 'photos/2026/a.jpg'), file('b.txt')]);
		expect(picked.files.map((item) => item.path)).toEqual(['photos/2026/a.jpg', 'b.txt']);
		expect(picked.emptyFolders).toEqual([]);
	});
});
