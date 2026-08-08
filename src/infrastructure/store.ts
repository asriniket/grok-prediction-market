import type { PostgresStore } from "./postgres-store.js";

/**
 * The store contract. Postgres is the only backend — a shared book is the point,
 * and a local file cannot be shared between machines.
 */
export type MarketStore = PostgresStore;
