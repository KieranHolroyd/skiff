import type { RequestHandler } from './$types';
import { scrape } from '#lib/server/metrics-scrape.js';

/**
 * Prometheus exposition on the control plane (DESIGN §8, docs/METRICS.md): `/metrics`, plus
 * `/metrics/{usage,apps,traffic,databases,storage,volumes,platform}[/<name>]` so a scraper can pull
 * only what it charts. Caddy can still restrict the path to the WireGuard interface.
 */
export const GET: RequestHandler = (event) => scrape(event, event.params.path.split('/').filter(Boolean));
export const HEAD = GET;
