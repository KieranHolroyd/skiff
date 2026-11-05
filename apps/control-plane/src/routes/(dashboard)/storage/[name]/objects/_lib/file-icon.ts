import type { Component } from 'svelte';
import FileIcon from '@lucide/svelte/icons/file';
import FileArchiveIcon from '@lucide/svelte/icons/file-archive';
import FileBracesIcon from '@lucide/svelte/icons/file-braces';
import FileCodeIcon from '@lucide/svelte/icons/file-code';
import FileHeadphoneIcon from '@lucide/svelte/icons/file-headphone';
import FileImageIcon from '@lucide/svelte/icons/file-image';
import FileSpreadsheetIcon from '@lucide/svelte/icons/file-spreadsheet';
import FileTextIcon from '@lucide/svelte/icons/file-text';
import FileVideoCameraIcon from '@lucide/svelte/icons/file-video-camera';

type Icon = Component<{ class?: string }>;

const groups: [Icon, string[]][] = [
	[
		FileImageIcon,
		['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'heic', 'tif', 'tiff']
	],
	[FileVideoCameraIcon, ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']],
	[FileHeadphoneIcon, ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']],
	[FileArchiveIcon, ['zip', 'tar', 'gz', 'tgz', 'zst', 'bz2', 'xz', '7z', 'rar', 'dump']],
	[FileBracesIcon, ['json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'xml']],
	[FileSpreadsheetIcon, ['csv', 'tsv', 'xls', 'xlsx', 'ods', 'parquet']],
	[
		FileCodeIcon,
		[
			'js',
			'mjs',
			'cjs',
			'ts',
			'tsx',
			'jsx',
			'svelte',
			'html',
			'css',
			'py',
			'go',
			'rs',
			'rb',
			'php',
			'sh',
			'sql'
		]
	],
	[FileTextIcon, ['txt', 'md', 'log', 'pdf', 'doc', 'docx', 'rtf', 'odt']]
];

const byExtension = new Map(
	groups.flatMap(([icon, extensions]) => extensions.map((ext) => [ext, icon] as const))
);

/** A file-type icon from the key's extension. */
export function fileIcon(key: string): Icon {
	const name = key.split('/').pop() ?? '';
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return FileIcon;
	return byExtension.get(name.slice(dot + 1).toLowerCase()) ?? FileIcon;
}
