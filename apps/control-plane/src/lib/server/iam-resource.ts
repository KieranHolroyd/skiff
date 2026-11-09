import type { ResourceRef } from '@yoal/contracts';

/**
 * `?resourceType=project&resourceId=prj_1&projectId=…&environmentId=…` into an engine `ResourceRef`.
 * `org` is the default, matching `requirePermission(principal, permission)`.
 */
export function resourceFromQuery(url: URL): ResourceRef {
	const type = (url.searchParams.get('resourceType') ?? 'org') as ResourceRef['type'];
	const resource: ResourceRef = { type };
	const id = url.searchParams.get('resourceId');
	const projectId = url.searchParams.get('projectId');
	const environmentId = url.searchParams.get('environmentId');
	if (id) resource.id = id;
	if (projectId) resource.projectId = projectId;
	if (environmentId) resource.environmentId = environmentId;
	return resource;
}
