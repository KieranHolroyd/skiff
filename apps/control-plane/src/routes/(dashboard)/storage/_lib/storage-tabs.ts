/** The in-place sections of a storage instance's page; Objects and Logs are their own routes. */
export const STORAGE_TABS = ['overview', 'buckets', 'metrics', 'settings'] as const;

export type StorageTab = (typeof STORAGE_TABS)[number];

export const STORAGE_DEFAULT_TAB: StorageTab = 'overview';
