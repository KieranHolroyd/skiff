import type { RequestHandler } from './$types.js';

/** Sentry SDKs post to `/envelope/` and `/store/` with a trailing slash. */
export const trailingSlash = 'ignore';
import { handleAppErrorIngest } from '#lib/server/app-errors-ingest.js';
import { core } from '#lib/server/core.js';

/** Legacy Sentry store ingest (docs/APP-ERRORS.md). Public, key-authenticated, CORS-enabled. */
export const POST: RequestHandler = ({ request, params }) =>
	handleAppErrorIngest(request, params.project, 'store', (input) => core.appErrors.ingest(input));

export const OPTIONS: RequestHandler = ({ request, params }) =>
	handleAppErrorIngest(request, params.project, 'store', (input) => core.appErrors.ingest(input));
