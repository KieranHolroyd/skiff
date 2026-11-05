/** The in-place sections of a database's detail page; Logs is its own route. */
export const DATABASE_TABS = ['overview', 'metrics', 'backups', 'insights', 'settings'] as const;

export type DatabaseTab = (typeof DATABASE_TABS)[number];

export const DATABASE_DEFAULT_TAB: DatabaseTab = 'overview';
