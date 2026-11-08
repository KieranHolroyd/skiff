/**
 * Automatic pipeline setup for every provider (docs/FORGES.md §7): the same org setting as
 * `/api/v1/github/pipeline-setup` — on/off, and which removed repositories stay removed.
 */
export { GET, PATCH } from '../../github/pipeline-setup/+server.js';
