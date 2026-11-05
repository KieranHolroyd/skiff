import { describe, expect, test } from 'bun:test';
import { inlineMediaType, previewOf } from './storage-preview';

describe('previewOf', () => {
	test('recognises media by extension, case-insensitively', () => {
		expect(previewOf('photos/Cat.JPG')?.kind).toBe('image');
		expect(previewOf('clips/intro.webm')?.kind).toBe('video');
		expect(previewOf('podcast/ep1.mp3')?.kind).toBe('audio');
		expect(previewOf('docs/invoice.pdf')?.kind).toBe('pdf');
	});

	test('treats source and markup as text, never as a document', () => {
		expect(previewOf('site/index.html')?.kind).toBe('text');
		expect(previewOf('config.yaml')?.kind).toBe('text');
		expect(previewOf('app/Dockerfile')?.kind).toBe('text');
	});

	test('has no preview for folders, dotfiles-only names or unknown types', () => {
		expect(previewOf('photos/')).toBeNull();
		expect(previewOf('.gitignore')).toBeNull();
		expect(previewOf('backup.tar.gz')).toBeNull();
		expect(previewOf('noextension')).toBeNull();
	});
});

describe('inlineMediaType', () => {
	test('keeps a stored type that matches the extension family', () => {
		expect(inlineMediaType('a.jpg', 'image/jpeg')).toBe('image/jpeg');
		expect(inlineMediaType('a.mov', 'video/quicktime; foo=bar')).toBe('video/quicktime');
	});

	test('falls back to the extension when the stored type is generic or wrong', () => {
		expect(inlineMediaType('a.png', 'application/octet-stream')).toBe('image/png');
		expect(inlineMediaType('a.png', 'text/html')).toBe('image/png');
		expect(inlineMediaType('a.pdf', null)).toBe('application/pdf');
	});

	test('refuses text and unknown types', () => {
		expect(inlineMediaType('index.html', 'text/html')).toBeNull();
		expect(inlineMediaType('blob.bin', 'image/png')).toBeNull();
	});
});
