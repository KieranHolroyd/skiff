import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from './systemd.ts';

/**
 * Node image prune (docs/REGISTRY.md R3).
 *
 * Nothing removed old images before, so every deploy of a new tag or digest left the previous one
 * on disk. The helper prunes what no unit and no container needs:
 *
 * - **Kept:** every image a Quadlet unit names (`Image=`, apps and managed services alike), every
 *   image a container (running or stopped) uses, and every `localhost/…` image. Local images were
 *   loaded with `podman load` and cannot be pulled again, so only an operator removes them.
 * - **Removed:** everything else, including dangling layers, with `podman rmi` and no `--force`,
 *   so an image podman still considers in use is skipped rather than broken.
 *
 * A rollback to a pruned digest pulls it again: deployments pin digests (R1), so that is the same
 * image. Nothing here touches `podman system prune`, volumes or build caches.
 */

export interface PodmanImage {
	Id: string;
	Names?: string[] | null;
	RepoDigests?: string[] | null;
	Size?: number;
	Containers?: number;
}

export interface ImagePruneResult {
	removed: Array<{ id: string; names: string[]; bytes: number }>;
	kept: number;
	reclaimedBytes: number;
	failed: Array<{ id: string; error: string }>;
}

const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

/** Fully qualify a reference the way podman stores names: `docker.io/library/x:latest`. */
export function normalizeImageRef(ref: string): string {
	let rest = ref.trim();
	let digest = '';
	const at = rest.indexOf('@');
	if (at >= 0) {
		digest = rest.slice(at);
		rest = rest.slice(0, at);
	}
	let tag = '';
	const colon = rest.lastIndexOf(':');
	if (colon > rest.lastIndexOf('/')) {
		tag = rest.slice(colon);
		rest = rest.slice(0, colon);
	}
	const slash = rest.indexOf('/');
	const first = slash > 0 ? rest.slice(0, slash) : '';
	let registry = 'docker.io';
	let path = rest;
	if (first && (first === 'localhost' || first.includes('.') || first.includes(':'))) {
		registry = DOCKER_HUB_ALIASES.has(first) ? 'docker.io' : first;
		path = rest.slice(slash + 1);
	}
	if (registry === 'docker.io' && !path.includes('/')) path = `library/${path}`;
	if (!tag && !digest) tag = ':latest';
	// containers/image drops the tag when a digest is present; match what podman records.
	return digest ? `${registry}/${path}${digest}` : `${registry}/${path}${tag}`;
}

/** `Image=` references from Quadlet unit texts (`.container` files). */
export function imagesInUnits(texts: readonly string[]): Set<string> {
	const refs = new Set<string>();
	for (const text of texts)
		for (const line of text.split('\n')) {
			const match = /^\s*Image\s*=\s*(\S+)\s*$/.exec(line);
			if (match && !match[1]!.endsWith('.image')) refs.add(normalizeImageRef(match[1]!));
		}
	return refs;
}

/** Split the images into those to keep and those to remove. Pure, for tests. */
export function planImagePrune(
	images: readonly PodmanImage[],
	keepRefs: ReadonlySet<string>,
): { keep: PodmanImage[]; remove: PodmanImage[] } {
	const keep: PodmanImage[] = [];
	const remove: PodmanImage[] = [];
	for (const image of images) {
		const names = (image.Names ?? []).map(normalizeImageRef);
		const digests = (image.RepoDigests ?? []).map(normalizeImageRef);
		const inUse = (image.Containers ?? 0) > 0;
		const local = names.some((name) => name.startsWith('localhost/'));
		const referenced = names.some((name) => keepRefs.has(name)) || digests.some((ref) => keepRefs.has(ref));
		if (inUse || local || referenced) keep.push(image);
		else remove.push(image);
	}
	return { keep, remove };
}

export async function pruneNodeImages(options: {
	runner: CommandRunner;
	podmanPath: string;
	quadletDir: string;
}): Promise<ImagePruneResult> {
	const { runner, podmanPath, quadletDir } = options;
	const unitTexts: string[] = [];
	for (const entry of await fs.readdir(quadletDir).catch(() => [] as string[])) {
		if (!entry.endsWith('.container')) continue;
		const text = await fs.readFile(join(quadletDir, entry), 'utf8').catch(() => null);
		if (text !== null) unitTexts.push(text);
	}
	const keepRefs = imagesInUnits(unitTexts);
	const listed = await runner.run([podmanPath, 'images', '--all', '--format', 'json']);
	if (listed.code !== 0)
		throw new Error(`podman images failed (${listed.code}): ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`);
	let images: PodmanImage[];
	try {
		const parsed = JSON.parse(listed.stdout || '[]') as unknown;
		images = Array.isArray(parsed) ? (parsed as PodmanImage[]).filter((image) => typeof image?.Id === 'string') : [];
	} catch {
		throw new Error('podman images returned invalid JSON');
	}
	const plan = planImagePrune(images, keepRefs);
	const result: ImagePruneResult = { removed: [], kept: plan.keep.length, reclaimedBytes: 0, failed: [] };
	for (const image of plan.remove) {
		const removed = await runner.run([podmanPath, 'rmi', image.Id]);
		if (removed.code === 0) {
			const bytes = Math.max(0, Math.floor(image.Size ?? 0));
			result.removed.push({ id: image.Id.slice(0, 12), names: image.Names ?? [], bytes });
			result.reclaimedBytes += bytes;
		} else {
			// In use by a container podman knows of, or a parent of another image: leave it.
			result.kept += 1;
			result.failed.push({ id: image.Id.slice(0, 12), error: (removed.stderr || removed.stdout).trim().slice(0, 200) });
		}
	}
	return result;
}
