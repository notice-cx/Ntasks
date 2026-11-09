# Appendix B. Open questions

Part of [the protocol](protocol.md). Draft, v0, 2026-11-09.

Each question is a place where Ntasks's behavior is unclear, looks
accidental, has no test, or is Ntasks's choice rather than something every
implementation needs. The draft states no rule for these. Each names the
sections it touches and what Ntasks does today.

### OQ-1

**Should a client name the task version it read?** <a id="oq-1"></a>
([INV-4](protocol.md#inv-4)) Ntasks applies each write to the version the
server read when it checked the write, and rereads up to three times when
another write got there first. No client sends a version, and `get_task`
does not return one; only a write's answer carries `version`. So an agent
that read a description an hour ago and then changes the task is not
refused because the description changed since. An `If-Match`-style
version would catch that, at the cost of more refusals.

### OQ-2

**Should a server ever let a claim lapse?** <a id="oq-2"></a>
([INV-2](protocol.md#inv-2)) Closed: no. A lease would free work whenever an
agent's session goes quiet, though the agent may still be working, and
another agent would then redo it. The protocol shows a quiet claim as
stalled instead ([STATE-16](protocol.md#state-16)), and a person frees it on
their own call or an agent frees it with evidence
([AUTH-9](protocol.md#auth-9)). Beads can treat claims as leases; Ntasks
never releases a claim because time passed.

### OQ-3

**Is `in_progress` with nobody holding it a state?** <a id="oq-3"></a>
([STATE-4](protocol.md#state-4)) `update_task` can set the status
`in_progress` without an assignee, and a claim then refuses the task. This
looks accidental: the protocol could make `in_progress` imply a holder. No
test covers the refusal.

### OQ-4

**How do the `deferred` status and `deferUntil` relate?**
<a id="oq-4"></a> ([STATE-2](protocol.md#state-2),
[STATE-3](protocol.md#state-3)) Ready work checks the defer time, and a
claim refuses the `deferred` status, but either can be set without the
other. No test covers a claim of a deferred task.

### OQ-5

**Should `blocked` record why?** <a id="oq-5"></a>
([STATE-2](protocol.md#state-2)) `blocked` is set by hand for a reason
outside the task graph, and nothing records the reason except an optional
comment.

### OQ-6

**Should retiring an approval keep its waiting tasks held?**
<a id="oq-6"></a> ([AUTH-7](protocol.md#auth-7)) Retiring or declining an
approval closes it, so the tasks that waited on it become ready work. What
stops the action is a comment on each of them, `The action must not happen
without a new action-specific owner approval`, and the record's
`permission: none`. A machine-readable exclusion on the waiting task, or
keeping it held, would not depend on the agent reading comments.

### OQ-7

**Should an agent be able to take the `human` label off?**
<a id="oq-7"></a> ([AUTH-8](protocol.md#auth-8)) `reconcile_task` with
action `routine` lets any sender that may change the project remove the
label from a task, with an explanation and evidence, returning it to
agents. A person cannot dispute it.

### OQ-8

**Should proof be checked, or required?** <a id="oq-8"></a>
([INV-7](protocol.md#inv-7)) A close as done without a commit, pull request
or link is shown as `proof: "none"` and warned about, never refused. The
server does not check that a named commit exists or holds the change. A
higher level could refuse a done close without proof, or check proof
against the repository. No test covers approvals closing without proof, or
each of bug, feature and chore needing it.

### OQ-9

**Should an approval carry its permission as a field?**
<a id="oq-9"></a> ([3.7](protocol.md#37-approval)) Ntasks keeps the answer
record, with `permission`, `scope`, `question` and earlier answers, in the
task's metadata under `noticeos_maintenance`, and returns only the `answer`
projection. A reader cannot tell from the protocol's objects alone whether
an approval's permission stands; it reads the gate's status and
`answer.disputedBy`.

### OQ-10

**One recommended option, or at most one?** <a id="oq-10"></a>
([3.6](protocol.md#36-decisions)) A new write needs exactly one option
marked `recommended`; Ntasks's Concepts page says at most one, and an
import may carry none. Option keys must run `a`, `b`, `c`… in order on a
write, which no test covers.

### OQ-11

**How long are retry records kept?** <a id="oq-11"></a>
([INV-3](protocol.md#inv-3), [MCP-2](mcp-profile.md#mcp-2)) Ntasks keeps a
caller's key for seven days. A write without a key over MCP is keyed by its
arguments and answers once only while the tasks it wrote are unchanged, and
for a new task only for 24 hours. The second rule is Ntasks's protection
for agents that resend a call; whether the protocol requires it is open.

### OQ-12

**Should "waits on a person" be a field rather than a label?**
<a id="oq-12"></a> ([3.2](protocol.md#32-task),
[3.6](protocol.md#36-decisions)) The label `human` carries authority:
`close_task` refuses a task carrying it, and only a person's answer or a
routine correction takes it off. A label is free text in most task tools,
and an adapter onto one may not be able to protect it.

### OQ-13

**Must task ids have Ntasks's form?** <a id="oq-13"></a>
([3.2](protocol.md#32-task)) Ntasks's ids are a prefix, a hyphen, a key and
`.n` for each level of child, as in Beads. An adapter onto a tool with
numbered issues needs another form; the schema's `taskId` pattern would
then move into a binding.

### OQ-14

**Is the proposal version portable?** <a id="oq-14"></a>
([3.6](protocol.md#36-decisions)) Ntasks hashes the JSON array of the
task's id, title, description, acceptance, type and choices. Only the
server that issued a version checks it, so the serialization need not be
shared unless a proposal moves between servers. No test recomputes the
hash or checks which fields go into it.

### OQ-15

**What makes an answer direct?** <a id="oq-15"></a>
([AUTH-1](protocol.md#auth-1)) In Ntasks only a person signed in to the
web app holds the scope that answers directly (`tasks:decide`); a person
calling the MCP endpoint is recorded as relaying their own answer. The
protocol needs a definition that does not name one product's interface.
Ntasks's connected apps, an app a person signs in to that acts as that
person, will add a second way to answer directly.

### OQ-16

**Should a model be verified?** <a id="oq-16"></a>
([AUTH-2](protocol.md#auth-2)) The model is whatever the agent says it runs
as. No test checks the model recorded in a history event.

### OQ-17

**How does a server erase personal data?** <a id="oq-17"></a>
([INV-6](protocol.md#inv-6)) Tasks, history and comments are never deleted
or edited. A request to erase a person's data needs a rule that keeps the
history's shape, such as replacing the text and actor while keeping the
event.

### OQ-18

**How does a server announce what it implements?** <a id="oq-18"></a>
([7](protocol.md#7-conformance-levels), [9](protocol.md#9-versioning))
Nothing in Ntasks names the protocol version or the levels it claims. MCP's
server information, an HTTP route, or the task guide could carry them.
Ntasks's own HTTP API versioning, a separate piece of work, may give the
place.

### OQ-19

**How are metadata keys namespaced?** <a id="oq-19"></a>
([EXT-1](protocol.md#ext-1)) Ntasks's keys use the prefix `noticeos_`, and
its MCP `create_task` takes only the five keys of a NoticeOS hand-off.
There is no separator rule and no list of namespaces.

### OQ-20

**Where do one system's own fields go?** <a id="oq-20"></a>
([8.3](protocol.md#83-fields-a-reader-does-not-know)) Ntasks returns
NoticeOS's `card`, `cardShipped` and `changeClass` beside the protocol's
fields, although it stores them in metadata. A namespaced object of
extensions would keep the task's top level to the protocol.

### OQ-21

**Should a person be able to decline an approval directly?**
<a id="oq-21"></a> ([AUTH-1](protocol.md#auth-1),
[STATE-10](protocol.md#state-10)) Ntasks's web app approves an approval
and disputes a relayed one, but has no route to decline one: a decline
arrives only as a relayed answer. A direct dismissal of a task labelled
`human` closes it without recording an `answer`, unlike a pick or a
response.

### OQ-22

**Should the HTTP binding name the product?** <a id="oq-22"></a>
([12](http-binding.md)) The routes live under `/api/tasks` and the
headers are `x-ntasks-workspace` and `x-ntasks-on-behalf-of`. A neutral
binding would need neutral header names, or let a server name its own.

### OQ-23

**Must each binding offer every operation of the levels it claims?**
<a id="oq-23"></a> ([12.2](http-binding.md#122-routes-by-level)) In Ntasks,
linking, asking for an approval, relaying an answer and releasing another
holder's task are MCP only, and a person's direct decisions are HTTP only.
The protocol could require a level per binding, or per server.

### OQ-24

**Should a task carry structured criteria?** <a id="oq-24"></a>
([3.10](protocol.md#310-acceptance-as-done),
[STATE-15](protocol.md#state-15)) Criteria are read from the free text of
`acceptance`, line by line, so an edit that splits or joins a line
renumbers them, and an acceptance relayed by number depends on the
proposal version it names. A list of criteria with stable ids would let a
person tick them one by one before the close, and let a server check each
one, at the cost of a second way to write what shows a task done.

### OQ-25

**Can a host tell the server that a session ended?** <a id="oq-25"></a>
([AUTH-9](protocol.md#auth-9), [STATE-16](protocol.md#state-16)) An agent's
host may know when the agent's session ends, such as Claude Code's
SessionEnd hook. The host could tell the server, which could then record
that the holder stopped, as the evidence AUTH-9 asks of an agent's release.
The protocol would need to say who may send it, how a server trusts it, and
whether it frees the task or only marks it.
