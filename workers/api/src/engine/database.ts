/**
 * The database the engine reads and writes through: the part of D1's
 * interface the engine uses. The engine's SQL runs unchanged over any SQLite
 * that offers it. The task store implements it over a Durable Object's own
 * storage (src/store/sqlite.ts).
 */

/** A value a statement binds. A boolean is stored as 1 or 0, as D1 stores it, and an ArrayBuffer as a BLOB. */
export type Bindable = string | number | boolean | null | ArrayBuffer;

export interface Statement {
  bind(...values: readonly Bindable[]): Statement;
  all<T>(): Promise<{ readonly results: T[] }>;
  /** The first row, or null when there is none. */
  first<T>(): Promise<T | null>;
  run(): Promise<void>;
}

export interface Database {
  prepare(sql: string): Statement;
  /** Runs the statements in one transaction: all of them land, or none do. */
  batch<T>(statements: readonly Statement[]): Promise<{ readonly results: T[] }[]>;
}
