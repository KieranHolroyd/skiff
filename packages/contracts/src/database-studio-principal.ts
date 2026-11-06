/**
 * The native studio's read-only principal (plan 22, track G). Every managed database gets one
 * `skiff_studio_ro` account, created by the helper's fixed `studio-principal` verb, so the database
 * itself refuses writes from a read-only studio session. Write sessions keep using the owner.
 *
 * The password is sealed in the control plane and reaches the node only through the
 * node-authenticated activation fetch, never desired state.
 */
import * as z from 'zod';
import { databaseEngines } from './database.ts';

/** The engine account every read-only studio session connects as. */
export const DATABASE_STUDIO_READONLY_USER = 'skiff_studio_ro';
/**
 * The database name whose owner identifier would collide with the principal. Every engine's
 * `reservedNames` lists it.
 */
export const DATABASE_STUDIO_READONLY_RESERVED_NAME = 'skiff-studio-ro';
/** Concurrent connections the principal may hold (Postgres, MySQL, MariaDB): two sessions of two. */
export const DATABASE_STUDIO_READONLY_CONNECTION_LIMIT = 4;
/**
 * The activation env name that carries the Valkey/Redis principal's password to the helper, which
 * renders it into the generated server config so a restart keeps the ACL user.
 */
export const DATABASE_STUDIO_READONLY_ENV = 'SKIFF_STUDIO_RO_PASSWORD';
/** Generated passwords are 24 random bytes in base64url (32 characters). */
export const studioPrincipalPasswordPattern = /^[A-Za-z0-9_-]{32,128}$/;

/** `ready`: usable. `preparing`: the node has not confirmed it yet. `failed`: see the error. */
export const databaseStudioPrincipalStates = ['ready', 'preparing', 'failed'] as const;
export type DatabaseStudioPrincipalState = (typeof databaseStudioPrincipalStates)[number];

/** Desired state: a database whose principal the node must (re)apply at this generation. */
export const databaseStudioPrincipalTaskSchema = z.object({
	databaseId: z.string().min(1).max(100),
	generation: z.number().int().positive(),
});
export type DatabaseStudioPrincipalTask = z.infer<typeof databaseStudioPrincipalTaskSchema>;

/** `GET /api/agent/database-studio-principal/:databaseId` (node bearer). Holds the password. */
export const databaseStudioPrincipalActivationSchema = z.object({
	databaseId: z.string().min(1).max(100),
	generation: z.number().int().positive(),
	engine: z.enum(databaseEngines),
	user: z.literal(DATABASE_STUDIO_READONLY_USER),
	password: z.string().regex(studioPrincipalPasswordPattern),
	/** The database the principal may read (`0` for Valkey/Redis, which have numbered databases). */
	database: z.string().min(1).max(100),
});
export type DatabaseStudioPrincipalActivation = z.infer<typeof databaseStudioPrincipalActivationSchema>;

/** Heartbeat outcome of one principal task. */
export const databaseStudioPrincipalResultSchema = z.object({
	databaseId: z.string().min(1).max(100),
	generation: z.number().int().positive(),
	status: z.enum(['ok', 'failed']),
	error: z.string().max(2_000).optional(),
});
export type DatabaseStudioPrincipalResult = z.infer<typeof databaseStudioPrincipalResultSchema>;
