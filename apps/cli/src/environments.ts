/**
 * Named project environments (D13). Production is built in; this file describes the view and
 * renders it. Pointers are moved on the platform, never computed here.
 */
import { formatTime, renderTable } from './output.ts';

export type EnvironmentAccess = 'public' | 'password' | 'platform' | 'access';

export interface EnvironmentView {
	id: string;
	projectId: string;
	projectSlug: string;
	name: string;
	slug: string;
	isProduction: boolean;
	access: EnvironmentAccess;
	accessPolicyId: string | null;
	passwordSet: boolean;
	host: string;
	deploymentId: string | null;
	createdAt: string;
}

export function environmentTable(environments: EnvironmentView[]): string {
	const rows = environments.map((environment) => [
		environment.name,
		environment.isProduction ? 'production' : environment.slug,
		environment.host,
		environment.access,
		environment.deploymentId ?? '-',
	]);
	return renderTable(['NAME', 'SLUG', 'HOST', 'ACCESS', 'DEPLOYMENT'], rows);
}

export function environmentDetails(environment: EnvironmentView): string[] {
	return [
		`Name        ${environment.name}`,
		`Slug        ${environment.slug}`,
		`Production  ${environment.isProduction ? 'yes' : 'no'}`,
		`Host        ${environment.host}`,
		`Access      ${environment.access}${environment.accessPolicyId ? ` (${environment.accessPolicyId})` : ''}`,
		`Password    ${environment.passwordSet ? 'set' : 'none'}`,
		`Deployment  ${environment.deploymentId ?? 'none'}`,
		`Created     ${formatTime(environment.createdAt)}`,
	];
}
