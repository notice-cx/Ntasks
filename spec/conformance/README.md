# The Shared Work Protocol conformance suite

This folder checks a server against the [Shared Work Protocol](../protocol.md),
draft v0, from outside: it sends the server's own MCP tool calls and HTTP
requests, as the [MCP tool profile](../mcp-profile.md) and the
[HTTP binding](../http-binding.md) name them, and reads what it answers. Each
check tests one rule, names that rule's section, and belongs to the
conformance level the rule is listed in ([section 7](../protocol.md#7-conformance-levels)).
The suite is licensed [Apache-2.0](../LICENSE-APACHE-2.0).

## Run it against a server

The checks file tasks into the target's `main` project, and the person's
into `hidden`, change and close them, and leave them there. Point the suite
at a test deployment or a test workspace, never at one people work in.

1. With Node.js 24, run `pnpm install` at the repository root.
2. Write a target file for the server. [`target.example.json`](target.example.json)
   is one, and [`target.schema.json`](target.schema.json) gives each field's
   rules and meaning.
3. From the repository root:

```sh
pnpm --filter @ntasks/spec run conformance -- --target path/to/target.json
```

| Option | Does |
|---|---|
| `--target <file>` | The target file to check |
| `--only <ids>` | Only these checks, by check id or rule id, separated by commas, such as `INV-1,inv-3-key-reuse-refused`. A level with checks left out reads `incomplete`, so such a run shows whether those checks pass, not which levels a server conforms to |
| `--binding mcp` or `--binding http` | Only that binding, of those the target offers |
| `--json <file>` | Also writes the whole report as JSON |
| `--list` | Lists every check with its level, rule, section and what it checks, and runs none |

The command exits 1 when a check of a claimed level failed, or a listed gap
passed; 2 when its arguments or the target file are wrong; and 0 otherwise,
including when a level reads `incomplete` or `known-gaps`. Read each
level's verdict, at the end of the report, before stating which levels a
server conforms to: only a level that reads `passed` is shown to conform.

### What the target names

| Field | Holds |
|---|---|
| `url` | The server's origin |
| `levels` | The levels the server claims: `core`, `human`, `delivery`, `live`. The suite runs those levels' checks |
| `bindings` | `mcp`, `http` or both, each with the path it answers at |
| `workspace` | The workspace the senders work in, for a server where a sender reaches several |
| `projects` | `main`, a project the agents and the service may change; `readOnly`, one the agents may only read; `hidden`, one the agents cannot reach and the person may file tasks in |
| `senders` | The headers that sign each sender in: `agent` and `otherAgent`, two agents with the same grants; `service`, a service credential; `person`, a person signed in to the server's own interface, who may decide in `main` |
| `repository` | The repository a delivery signal names, as `owner/name` |
| `knownGaps` | Checks the server is known to fail, each with its reason ([below](#known-gaps)) |

`service`, `person`, `readOnly` and `hidden` are optional. A check that needs
one the target leaves out is skipped, and its level reads `incomplete`
instead of `passed`. A person's own decisions are HTTP routes in the
binding, so the checks of a person's pick, answer, dismissal, approval and
dispute run over HTTP only.

## Reading the report

The report has one line per check: its result, its rule, its id, and its
result on each binding the target offers.

| Result | Means |
|---|---|
| `pass` | It passed on at least one binding and failed on none |
| `FAIL` | It failed on a binding. The lines after the list give what was expected, what the server answered, and each request the check sent |
| `warn` | A check of a SHOULD rule failed. It fails nothing |
| `skip` | The target names no sender, project or binding the check needs, on at least one binding that offers the call |
| `gap` | It failed, and the target lists it as a known gap |

On a binding, `-` means the binding offers no way to make the call the check
tests, such as linking two tasks over HTTP, and `skipped` that it offers the
call but the target names no sender the check needs for it, such as a person
for the HTTP binding's approval. A check runs once on each binding
the target offers. It arranges what it needs, such as a task waiting on an
approval, through MCP when the server offers it, and through HTTP for the
person; then it makes the call it tests through the binding under test.
Where a rule says a refused write leaves nothing behind, the check reads the
task, its comments and its history before and after the write and compares
them.

The last lines give each level's verdict:

| Verdict | Means |
|---|---|
| `passed` | Every check of the level ran, and none of a MUST rule failed. A check of a SHOULD rule that failed reads `warn` in the list above |
| `known-gaps` | Every check ran, and each one that failed is a listed gap |
| `failed` | A check failed, or a listed gap passed |
| `incomplete` | Some of its checks did not run, or `--only` left them out |
| `not-claimed` | The target does not claim the level |

### Known gaps

A target may list checks the server is known to fail in `knownGaps`, by
check id or as `<check id>@<binding>`, each with its reason, such as the
task that tracks the fix. A listed check that fails reads `gap` and fails
nothing. A listed check that passes fails the run, so the list is updated
when the server is fixed.

## Against Ntasks

```sh
pnpm --filter @ntasks/spec run conformance:ntasks
```

It starts this repository's Worker on a local port with wrangler's test
harness, writes a workspace, three projects, two agents, a service
credential and a signed-in person into the Worker's local D1 database, runs
every check of the four levels, and stops the Worker. It reaches no deployed
Ntasks and no Cloudflare account. CI runs it on every pull request.
[`ntasks/local.ts`](ntasks/local.ts) writes the rows Ntasks writes itself
when a person signs in and approves an agent, and lists the checks Ntasks
fails today in `KNOWN_GAPS`, each with the task that fixes it. `--only`
works here too.

The files under [`ntasks/`](ntasks/) run the suite against Ntasks and stay
with Ntasks if the protocol moves to a home of its own; the rest of this
folder names no Ntasks internals.

## The broken server

[`fixtures/broken.ts`](fixtures/broken.ts) is a server that breaks one rule
on purpose: a proxy in front of a conforming server that changes one kind of
call or answer and passes everything else through unchanged. Its `DEFECTS`
list each one with the rule it breaks, such as answering a claim refused as
held by someone else as a success (INV-1). [`../test/conformance.test.ts`](../test/conformance.test.ts)
runs every check through each defect, in front of a local Ntasks Worker,
and fails unless exactly the checks of that rule fail. The same test fails
when a check names a rule the protocol does not define, or when a rule a
level lists has no check at that level.

```sh
pnpm --filter @ntasks/spec test
```

## What the checks cannot see

Some rules, or parts of them, are not observable from outside a server
within a test run:

| Rule | Not checked |
|---|---|
| [INV-2](../protocol.md#inv-2) | A claim's state after more than two seconds without activity |
| [INV-4](../protocol.md#inv-4) | The answer when the server gives up after rereading a task that kept changing, which a client cannot cause on purpose |
| [INV-5](../protocol.md#inv-5) | That a write changing several tasks commits as one, which needs a failure partway through |
| [INV-6](../protocol.md#inv-6) | Deleting a task, an event or a comment: no binding offers a deletion to try. The check reads earlier history and comments again and compares them |
| [AUTH-10](../protocol.md#auth-10) | That a link to a task the sender cannot reach is left out of answers |
| [STATE-9](../protocol.md#state-9) | The SHOULD that a server lists the epics that can close |
| [STATE-14](../protocol.md#state-14) | A refused change to a step's text or command: no binding offers such a change to try |
| [EXT-1](../protocol.md#ext-1) | Metadata a server does not take: a server MAY limit the keys a write takes, so a refused key passes |
| [EXT-2](../protocol.md#ext-2) | Custom fields, which no level requires |
| [VER-1](../protocol.md#ver-1) to [VER-3](../protocol.md#ver-3) | Rules of the document and its schemas; [`../test/schemas.test.ts`](../test/schemas.test.ts) checks the schemas' `$id`s |

## Adding a check

A check is an entry in `src/checks/`, in the file of its level: an `id` that
starts with its rule's id in lowercase, the `rule`, the `level`, a `title`
saying what a server that keeps the rule does, and `run`, which calls the
binding under test through `context.api()` and arranges through
`context.setup()`. An operation one binding lacks is reported as `-` for that
binding. When a check should catch one of the broken server's defects, add
its id to that defect's list in `../test/conformance.test.ts`.
