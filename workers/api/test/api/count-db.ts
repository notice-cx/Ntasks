// A D1 binding that counts what each request costs: its round trips to the
// database, the statements it runs, and the rows those statements read, which
// is what D1 bills and what its free daily allowance limits.
export interface DbCost {
  roundTrips: number;
  statements: number;
  rowsRead: number;
}

interface Meta {
  readonly meta?: { readonly rows_read?: number };
}

export function countingDb(db: D1Database): { readonly db: D1Database; readonly cost: DbCost; reset(): void } {
  const cost: DbCost = { roundTrips: 0, statements: 0, rowsRead: 0 };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const read = (result: unknown) => {
    cost.rowsRead += (result as Meta | null)?.meta?.rows_read ?? 0;
    return result;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'all' || property === 'run' || property === 'first' || property === 'raw') {
          return async (...args: unknown[]) => {
            cost.roundTrips += 1;
            cost.statements += 1;
            const method = Reflect.get(target, property, target) as (...rest: unknown[]) => Promise<unknown>;
            const result = await method.apply(target, args);
            return property === 'all' || property === 'run' ? read(result) : result;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          cost.roundTrips += 1;
          cost.statements += statements.length;
          const results = await target.batch(statements.map((statement) => originals.get(statement) ?? statement));
          for (const result of results) read(result);
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    db: counted,
    cost,
    reset() {
      cost.roundTrips = 0;
      cost.statements = 0;
      cost.rowsRead = 0;
    },
  };
}
