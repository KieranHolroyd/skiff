import { json } from '#lib/server/api.js';
import { assistantStatus } from '#lib/server/assistant/config.js';
import type { RequestHandler } from './$types';

/** The dashboard launcher and the chat panel read this before rendering. */
export const GET: RequestHandler = () => json(assistantStatus());
