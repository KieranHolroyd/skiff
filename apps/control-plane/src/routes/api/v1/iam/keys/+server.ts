import type { RequestHandler } from './$types';
import {
	AUTO_ROTATION_PURPOSES,
	ForbiddenError,
	IAM_KEYS_ROTATED_STATE_KEY,
	KEY_ROTATION_INTERVAL_MS,
	KEY_ROTATION_OVERLAP_MS,
	rotatesAutomatically,
	signingKeyRotationDecision,
} from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The signing-key ring for the platform (IAM.md I15, §7.3). `GET` is a read-only operator view:
 * every purpose, its active and next kid, retired-key count and the rotation decision the monthly
 * sweep would take. No private material is returned.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		if (!core.ctx.platformIam.canView(principal))
			throw new ForbiddenError('platform:read', 'signing keys are platform-wide');

		const now = core.ctx.now();
		const marker = core.ctx.sqlite
			.query<{ last_value: string | null }, [string]>(
				'SELECT last_value FROM alert_state WHERE key = ?',
			)
			.get(IAM_KEYS_ROTATED_STATE_KEY);
		const markerAt = marker?.last_value ? Number(marker.last_value) : null;
		const lastRotatedAt = markerAt !== null && Number.isFinite(markerAt) ? markerAt : null;

		const purposes = [
			...new Set([...AUTO_ROTATION_PURPOSES, ...core.ctx.signingKeys.purposes()]),
		].sort();
		return {
			purposes: purposes.map((purpose) => {
				const records = core.ctx.signingKeys.list(purpose);
				const active = records.find((record) => record.state === 'active') ?? null;
				const next = records.find((record) => record.state === 'next') ?? null;
				const decision = signingKeyRotationDecision({
					activeActivatedAt: active ? (active.activatedAt ?? active.createdAt) : null,
					nextCreatedAt: next?.createdAt ?? null,
					now,
				});
				return {
					purpose,
					automatic: rotatesAutomatically(purpose),
					active: active
						? { kid: active.kid, createdAt: active.createdAt, activatedAt: active.activatedAt }
						: null,
					next: next ? { kid: next.kid, createdAt: next.createdAt } : null,
					retired: records.filter((record) => record.state === 'retired').length,
					keys: records.map((record) => ({
						kid: record.kid,
						alg: record.alg,
						state: record.state,
						createdAt: record.createdAt,
						activatedAt: record.activatedAt,
						retireAfter: record.retireAfter,
					})),
					rotation: {
						due: decision.due,
						action: decision.action,
						reason: decision.reason,
					},
				};
			}),
			policy: {
				intervalDays: KEY_ROTATION_INTERVAL_MS / DAY_MS,
				overlapHours: KEY_ROTATION_OVERLAP_MS / HOUR_MS,
				automaticPurposes: AUTO_ROTATION_PURPOSES,
			},
			lastRotatedAt,
			nextCheckAt: lastRotatedAt === null ? null : lastRotatedAt + KEY_ROTATION_INTERVAL_MS,
			can: {
				rotate: core.ctx.platformIam.canMaintain(principal),
			},
		};
	});
