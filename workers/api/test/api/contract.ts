// The recorded contract of the HTTP API's answers, and how an answer is
// compared with it. Each file in api-versions/ is one version: what it added,
// and the fields it added to each route's answer, with the type of each, by
// path: `tasks[].title` is the title of each task in `tasks`. A shared shape,
// such as a task, is recorded once under `shapes` and named from a route as
// `@task`, or as `@task|null` where the answer may be null instead. A
// version can also name arrays that answer empty from then on: they stay in
// the answer, with their entries' recorded fields, for clients made for
// earlier versions.

/** What a value is, as the contract names it. `map` is an object whose keys
 * are data, such as a task's custom field values: its entries are not fields.
 * `absent` is a field some answers leave out. */
export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'map' | 'absent';

/** Each path's allowed types, joined with `|`; `@name` among them is a shared shape. */
export type Recorded = Readonly<Record<string, string>>;

/** One file of api-versions/: one version of the API. */
export interface ContractVersion {
  /** What the version added, in one line of Markdown. */
  readonly added: string;
  readonly shapes?: Readonly<Record<string, Recorded>>;
  readonly routes?: Readonly<Record<string, Recorded>>;
  /** Each route's arrays, by path, that answer empty from this version on. */
  readonly emptied?: Readonly<Record<string, readonly string[]>>;
}

/** Where a shared shape is written out in a route: its name, and the path it starts at. */
interface Placed {
  readonly name: string;
  readonly at: string;
}

/** One recorded path of a route: its allowed types, the shared shape it was
 * recorded in, if any, and the shape it names, if it names one. */
interface Field {
  readonly types: ReadonlySet<ValueType>;
  readonly in: Placed | null;
  readonly names: Placed | null;
}

/** Every path of a route, with the shared shapes it names written out. */
export type RouteContract = ReadonlyMap<string, Field>;

/** What every answer of a route held: the types each path was seen with,
 * and the keys of each object seen at each path, which show the keys some
 * objects leave out. */
export interface Observed {
  readonly types: Map<string, Set<ValueType>>;
  readonly keys: Map<string, Set<string>[]>;
}

/** Nothing observed yet, for one route. */
export function observed(): Observed {
  return { types: new Map(), keys: new Map() };
}

const join = (at: string, key: string) => (at === '' ? key : `${at}.${key}`);

/** The shapes and routes of every version merged, each path recorded once.
 * The versions are numbered from 1 in the order given. */
export function merge(versions: readonly ContractVersion[]): {
  readonly version: number;
  readonly shapes: Readonly<Record<string, Recorded>>;
  readonly routes: Readonly<Record<string, Recorded>>;
  readonly emptied: Readonly<Record<string, readonly string[]>>;
} {
  const shapes: Record<string, Record<string, string>> = {};
  const routes: Record<string, Record<string, string>> = {};
  const emptied: Record<string, string[]> = {};
  for (const entry of versions) {
    for (const [route, paths] of Object.entries(entry.emptied ?? {})) {
      const merged = (emptied[route] ??= []);
      for (const path of paths) {
        if (merged.includes(path)) throw new Error(`${route} ${path} is emptied twice`);
        merged.push(path);
      }
    }
    for (const [into, from] of [
      [shapes, entry.shapes ?? {}],
      [routes, entry.routes ?? {}],
    ] as const) {
      for (const [name, paths] of Object.entries(from)) {
        const merged = (into[name] ??= {});
        for (const [path, types] of Object.entries(paths)) {
          if (path in merged) throw new Error(`${name} ${path} is recorded twice; a field keeps its type`);
          merged[path] = types;
        }
      }
    }
  }
  return { version: versions.length, shapes, routes, emptied };
}

/** A route's recorded paths, with each `@shape` it names written out under its path. */
export function expand(recorded: Recorded, shapes: Readonly<Record<string, Recorded>>): RouteContract {
  const fields = new Map<string, Field>();
  const add = (paths: Recorded, placed: Placed | null, seen: readonly string[]) => {
    for (const [path, types] of Object.entries(paths)) {
      const full = placed === null ? path : `${placed.at}${path.startsWith('[]') ? '' : '.'}${path}`;
      const listed = types.split('|');
      const name = listed.find((type) => type.startsWith('@'))?.slice(1);
      const own = listed.filter((type) => !type.startsWith('@')) as ValueType[];
      if (name === undefined) {
        fields.set(full, { types: new Set(own), in: placed, names: null });
        continue;
      }
      const named = shapes[name];
      if (!named) throw new Error(`${full} names no shape ${name}`);
      if (seen.includes(name)) throw new Error(`shape ${name} names itself`);
      const names = { name, at: full };
      fields.set(full, { types: new Set<ValueType>([...own, 'object']), in: placed, names });
      add(named, names, [...seen, name]);
    }
  };
  add(recorded, null, []);
  return fields;
}

function typeOf(value: unknown): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return type;
  throw new Error(`an answer holds a ${typeof value}`);
}

/** Adds the types of `answer`'s fields, and the keys of its objects, to
 * `into`. A path the contract records as `map` is not looked into. */
export function observe(answer: unknown, contract: RouteContract, into: Observed): void {
  const { types, keys } = into;
  const walk = (value: unknown, at: string) => {
    let type = typeOf(value);
    if (type === 'object' && contract.get(at)?.types.has('map')) type = 'map';
    if (at !== '') typed(types, at, type);
    if (type === 'array') for (const entry of value as unknown[]) walk(entry, `${at}[]`);
    if (type !== 'object') return;
    const entries = Object.entries(value as Record<string, unknown>);
    if (!keys.has(at)) keys.set(at, []);
    keys.get(at)!.push(new Set(entries.map(([key]) => key)));
    for (const [key, entry] of entries) walk(entry, join(at, key));
  };
  walk(answer, '');
}

function typed(types: Map<string, Set<ValueType>>, path: string, type: ValueType): void {
  if (!types.has(path)) types.set(path, new Set());
  types.get(path)!.add(type);
}

/** Each path's types over every answer, with `absent` where some objects at its place hold the key and others leave it out. */
function typesOf({ types, keys }: Observed): ReadonlyMap<string, ReadonlySet<ValueType>> {
  const all = new Map([...types].map(([path, seen]) => [path, new Set(seen)]));
  for (const [at, objects] of keys) {
    const every = new Set(objects.flatMap((object) => [...object]));
    for (const key of every) if (objects.some((object) => !object.has(key))) typed(all, join(at, key), 'absent');
  }
  return all;
}

export interface Differences {
  /** Recorded paths every object at their place leaves out, where the contract does not allow that. */
  readonly removed: readonly string[];
  /** Recorded paths an answer holds with a type the contract does not allow. */
  readonly retyped: readonly string[];
  /** Paths the answers hold that the contract does not record, each as the line that records it. */
  readonly unrecorded: readonly string[];
  /** Arrays a version emptied that an answer gave an entry. */
  readonly filled: readonly string[];
  /** Each recorded field that can hold a value, keyed by where it is recorded
   * (its shared shape, or its route) and its path there: whether an answer
   * gave it one. A type can only be checked on a value. */
  readonly valued: ReadonlyMap<string, boolean>;
}

/** The path of the object or array a path is in, '' for the answer itself. */
function parentOf(path: string): string {
  if (path.endsWith('[]')) return path.slice(0, -2);
  return path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : '';
}

const VALUELESS: ReadonlySet<ValueType> = new Set(['absent', 'null']);

/** How one route's answers differ from its contract, where `emptied` names
 * the arrays that answer empty. An emptied array's entries hold no value to
 * check, so their fields are left out of `valued`. */
export function compare(
  route: string,
  contract: RouteContract,
  answers: Observed,
  emptied: readonly string[] = [],
): Differences {
  const observed = typesOf(answers);
  const removed: string[] = [];
  const retyped: string[] = [];
  const unrecorded: string[] = [];
  const valued = new Map<string, boolean>();
  for (const path of emptied)
    if (!contract.get(path)?.types.has('array')) throw new Error(`${route} ${path} is emptied but records no array`);
  const filled = emptied.filter((path) => observed.has(`${path}[]`)).map((path) => `${route} ${path}`);
  const inEmptied = (path: string) => emptied.some((at) => path.startsWith(`${at}[]`));
  const named = (path: string, field: Field) =>
    field.in ? `${route} ${path} (shape ${field.in.name})` : `${route} ${path}`;
  for (const [path, field] of contract) {
    const types = observed.get(path);
    const parent = parentOf(path);
    // A field is looked for only where its object was answered: not under a null, or in an empty array.
    const placed = parent === '' || [...(observed.get(parent) ?? [])].some((type) => !VALUELESS.has(type));
    if (types === undefined) {
      if (placed && !path.endsWith('[]') && !field.types.has('absent')) removed.push(named(path, field));
    } else if ([...types].some((type) => !field.types.has(type))) {
      retyped.push(`${named(path, field)}: answered as ${listed(types)}, recorded as ${listed(field.types)}`);
    }
    if ([...field.types].every((type) => VALUELESS.has(type)) || inEmptied(path)) continue;
    const key = field.in
      ? `shape ${field.in.name} ${path.slice(field.in.at.length).replace(/^\./u, '')}`
      : `${route} ${path}`;
    const gave = [...(types ?? [])].some((type) => !VALUELESS.has(type));
    valued.set(key, (valued.get(key) ?? false) || gave);
  }
  for (const [path, types] of observed) {
    if (contract.has(path)) continue;
    // The line goes in the shared shape the nearest recorded path above it belongs to, if any.
    const above = [...contract.keys()]
      .filter((at) => path.startsWith(`${at}.`) || path.startsWith(`${at}[]`))
      .sort((a, b) => b.length - a.length)[0];
    const field = above === undefined ? undefined : contract.get(above);
    const shape = field?.names ?? field?.in ?? null;
    const relative = shape === null ? path : path.slice(shape.at.length).replace(/^\./u, '');
    const line = `"${relative}": "${listed(types)}"`;
    unrecorded.push(shape === null ? `routes["${route}"]: ${line}` : `shapes.${shape.name}: ${line}`);
  }
  return { removed, retyped, unrecorded, filled, valued };
}

/** The recorded fields no route's answers gave a value, so their type went unchecked. */
export function withoutValue(differences: readonly Differences[]): string[] {
  const gave = new Map<string, boolean>();
  for (const { valued } of differences)
    for (const [key, value] of valued) gave.set(key, (gave.get(key) ?? false) || value);
  return [...gave].filter(([, value]) => !value).map(([key]) => key);
}

const listed = (types: ReadonlySet<ValueType>) => [...types].sort().join('|');
