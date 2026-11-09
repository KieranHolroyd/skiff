import type { RequestHandler } from './$types';
import {
	buildEnvSuggestions,
	type DatabaseAttachmentView,
	type DetectedEnvName,
	type StorageAttachmentView,
	type UserPoolAttachmentView
} from '@yoal/contracts';
import { json, route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Suggested environment variables for the runtime editor (the Railway "suggested variables"
 * idea): names the platform injects for attached services, secret names, and names found in
 * the deployment's `.env*` files and source.
 *
 * Loaded lazily when the editor opens: scanning a release can download and inflate its zip.
 * Only names cross the wire — values in a committed `.env` are never returned.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);

		let databases: DatabaseAttachmentView[] = [];
		let storage: StorageAttachmentView[] = [];
		let userPools: UserPoolAttachmentView[] = [];
		let secretNames: string[] = [];
		let detected: DetectedEnvName[] = [];

		try {
			databases = core.databases.attachments(principal, project);
		} catch {
			// The editor still works; suggestions are a convenience.
		}
		try {
			storage = core.storage.attachments(principal, project);
		} catch {
			// Same as databases.
		}
		try {
			userPools = core.userPools.attachments(principal, project);
		} catch {
			// Same as databases.
		}
		try {
			secretNames = core.secrets
				.list(principal, { visibleTo: project.id })
				.map((secret) => secret.name);
		} catch {
			// Without secret:read-metadata the plain env suggestions still work.
		}
		if (project.runtime !== 'static') {
			try {
				detected = (await core.source.envSuggestions(principal, project)).names;
			} catch {
				// No deployment yet, or the artifact cannot be read. Attached-service names still apply.
			}
		}

		return json(
			{
				suggestions: buildEnvSuggestions({
					databases: databases.map((item) => ({
						name: item.databaseName,
						envNames: item.envNames
					})),
					storage: storage.map((item) => ({
						name: item.storageName,
						envNames: item.envNames
					})),
					userPools: userPools.map((item) => ({
						name: item.poolName,
						envNames: item.envNames
					})),
					secretNames,
					detected
				})
			},
			200,
			{ 'cache-control': 'no-store' }
		);
	});
