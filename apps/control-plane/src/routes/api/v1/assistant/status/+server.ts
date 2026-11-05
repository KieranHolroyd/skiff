import { json } from '#lib/server/api.js';
import { assistantStatusWithAgents } from '#lib/server/assistant/settings.js';
import type { RequestHandler } from './$types';

/** The dashboard launcher and the chat panel read this before rendering. */
export const GET: RequestHandler = () => json(assistantStatusWithAgents());
