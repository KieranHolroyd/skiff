/** In-place sections of a broker's detail page; logs is its own route. */
export const BROKER_TABS = ['overview', 'queues', 'metrics', 'settings'] as const;
export type BrokerTab = (typeof BROKER_TABS)[number];
export const BROKER_DEFAULT_TAB: BrokerTab = 'overview';
