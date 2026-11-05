/**
 * Turning what the browser hands us (a drop, a file picker, a folder picker) into a flat list of
 * files with their paths relative to the drop point, so a dropped folder keeps its shape as
 * key prefixes. Empty directories are reported separately so they can become folder markers.
 */

export interface PickedFile {
	file: File;
	/** Path relative to the upload target, `/`-separated, e.g. `photos/2026/a.jpg`. */
	path: string;
}

export interface Picked {
	files: PickedFile[];
	/** Relative paths of directories that contained nothing, e.g. `photos/empty`. */
	emptyFolders: string[];
}

/** Path segments that are safe to use in an object key: no empty, `.` or `..` segments. */
function segments(path: string): string[] {
	return path
		.replace(/\\/g, '/')
		.split('/')
		.filter((part) => part !== '' && part !== '.' && part !== '..');
}

/** The object key for a file at `relativePath` uploaded into `prefix` (which ends in `/` or is empty). */
export function uploadKey(prefix: string, relativePath: string): string {
	return `${prefix}${segments(relativePath).join('/')}`;
}

/** The folder-marker key for an empty directory at `relativePath` under `prefix`. */
export function folderKey(prefix: string, relativePath: string): string {
	const joined = segments(relativePath).join('/');
	return joined ? `${prefix}${joined}/` : '';
}

/** Files from an `<input type="file">`, with or without `webkitdirectory`. */
export function fromFileList(list: FileList | File[]): Picked {
	const files = Array.from(list, (file) => ({
		file,
		path: file.webkitRelativePath || file.name
	})).filter((item) => segments(item.path).length > 0);
	return { files, emptyFolders: [] };
}

/** True when a drag carries files (not text or a link dragged from the page). */
export function dragHasFiles(event: DragEvent): boolean {
	return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, base: string, out: Picked): Promise<void> {
	const path = base ? `${base}/${entry.name}` : entry.name;
	if (entry.isFile) {
		out.files.push({ file: await entryFile(entry as FileSystemFileEntry), path });
		return;
	}
	if (!entry.isDirectory) return;
	const reader = (entry as FileSystemDirectoryEntry).createReader();
	// readEntries hands back at most ~100 entries per call; keep reading until it returns none.
	const children: FileSystemEntry[] = [];
	for (;;) {
		const batch = await readBatch(reader);
		if (batch.length === 0) break;
		children.push(...batch);
	}
	if (children.length === 0) {
		out.emptyFolders.push(path);
		return;
	}
	for (const child of children) await walk(child, path, out);
}

/**
 * Collect a drop. The `DataTransferItemList` is only readable during the drop event itself, so the
 * entries are taken synchronously here and walked afterwards.
 */
export function fromDataTransfer(transfer: DataTransfer): Promise<Picked> {
	const entries = Array.from(transfer.items)
		.filter((item) => item.kind === 'file')
		.map((item) => item.webkitGetAsEntry?.() ?? null);
	if (entries.length === 0 || entries.some((entry) => entry === null)) {
		// No entry API (or something we can't walk): fall back to the flat file list.
		return Promise.resolve(fromFileList(transfer.files));
	}
	return (async () => {
		const out: Picked = { files: [], emptyFolders: [] };
		for (const entry of entries) await walk(entry!, '', out);
		return out;
	})();
}
