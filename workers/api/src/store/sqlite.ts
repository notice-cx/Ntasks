/**
 * The engine's Database over a Durable Object's SQLite storage. A batch is
 * one transaction, so a refused statement in it undoes the whole batch, as a
 * D1 batch does. Each statement runs beside the data, with no network trip.
 */
import type { Bindable, Database, Statement } from '../engine/database.ts';

/** What the statements cost: D1 and Durable Objects bill and limit rows read and written. */
export interface Meter {
  statements: number;
  rowsRead: number;
  rowsWritten: number;
}

export function newMeter(): Meter {
  return { statements: 0, rowsRead: 0, rowsWritten: 0 };
}

/** Runs `work` with the object's storage: directly inside the object, or
 * inside it from a test (test/store.ts). */
export type WithStorage = <R>(work: (storage: DurableObjectStorage) => R) => Promise<R>;

type Row = Record<string, SqlStorageValue>;

class SqliteStatement implements Statement {
  constructor(
    readonly database: SqliteDatabase,
    readonly sql: string,
    readonly values: readonly SqlStorageValue[] = [],
  ) {}

  bind(...values: readonly Bindable[]): Statement {
    return new SqliteStatement(
      this.database,
      this.sql,
      values.map((value) => (typeof value === 'boolean' ? Number(value) : value)),
    );
  }

  async all<T>(): Promise<{ readonly results: T[] }> {
    return { results: (await this.database.run(this)) as T[] };
  }

  async first<T>(): Promise<T | null> {
    const [row] = await this.database.run(this);
    return (row as T | undefined) ?? null;
  }

  async run(): Promise<void> {
    await this.database.run(this);
  }
}

class SqliteDatabase implements Database {
  constructor(
    readonly withStorage: WithStorage,
    readonly meter: Meter | undefined,
  ) {}

  prepare(sql: string): Statement {
    return new SqliteStatement(this, sql);
  }

  run(statement: SqliteStatement): Promise<Row[]> {
    return this.withStorage((storage) => this.execute(storage, statement));
  }

  async batch<T>(statements: readonly Statement[]): Promise<{ readonly results: T[] }[]> {
    const own = statements.map((statement) => {
      if (!(statement instanceof SqliteStatement) || statement.database !== this)
        throw new TypeError('a batch takes statements this database prepared');
      return statement;
    });
    return this.withStorage((storage) =>
      storage.transactionSync(() => own.map((statement) => ({ results: this.execute(storage, statement) as T[] }))),
    );
  }

  /** Runs one statement to its end, so its rows read and written are counted. */
  execute(storage: DurableObjectStorage, statement: SqliteStatement): Row[] {
    const cursor = storage.sql.exec<Row>(statement.sql, ...statement.values);
    const rows = cursor.toArray();
    if (this.meter) {
      this.meter.statements += 1;
      this.meter.rowsRead += cursor.rowsRead;
      this.meter.rowsWritten += cursor.rowsWritten;
    }
    return rows;
  }
}

export function sqliteDatabase(withStorage: WithStorage, meter?: Meter): Database {
  return new SqliteDatabase(withStorage, meter);
}

/** The Database of the object whose storage this is, used from inside it. */
export function objectDatabase(storage: DurableObjectStorage, meter?: Meter): Database {
  return sqliteDatabase(async (work) => work(storage), meter);
}
