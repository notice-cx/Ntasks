# Appendix A. Each rule and the Ntasks test that proves it

Part of [the protocol](protocol.md). Draft, v0, 2026-11-10.

Each row names a test in the Ntasks repository that exercises the rule
today, by its file and its name. These tests run inside Ntasks against its
own engine; the [conformance suite](conformance/README.md) checks the same
rules against any server from outside, Ntasks included. [`test/appendix.test.ts`](test/appendix.test.ts)
fails when a test named here no longer exists, or when a rule of the
protocol appears in neither table.

## Rules with a test

| Rule | Ntasks test |
|---|---|
| STATE-1 | `workers/api/test/schema.test.ts` › "refuses a status the model does not have" |
| STATE-1 | `workers/api/test/schema.test.ts` › "refuses a closed task that does not record its close" |
| STATE-3 | `workers/api/test/engine/ready.test.ts` › "holds a task until every task blocking it is closed" |
| STATE-3 | `workers/api/test/engine/ready.test.ts` › "holds every descendant of a blocked parent, at any depth, and only while the parent is open" |
| STATE-3 | `workers/api/test/engine/ready.test.ts` › "holds a task deferred to a later time, and the children of a parent deferred to one" |
| STATE-3 | `workers/api/test/engine/ready.test.ts` › "opens a gate the task waits on, which no agent sees as work, until a person closes it" |
| STATE-4 | `workers/api/test/api/write-tools.test.ts` › "refuses a task someone else holds, a closed one and one that is not open" |
| STATE-5 | `workers/api/test/engine/writes.test.ts` › "lets a person give a held task to someone else, or release it" |
| STATE-6 | `workers/api/test/api/write-tools.test.ts` › "refuses what the task state forbids: a new choice set, a shipped card, a human label, a held hand-over" |
| STATE-7 | `workers/api/test/api/write-tools.test.ts` › "refuses a task held by someone else, one waiting on an approval or on open children, and a person’s decision" |
| STATE-7 | `workers/api/test/api/write-tools.test.ts` › "closes a duplicate, linking it to the task it duplicates" |
| STATE-8 | `workers/api/test/engine/writes.test.ts` › "reopens a closed task with no close left on it, and keeps the earlier close in history (rule 6)" |
| STATE-8 | `workers/api/test/api/delivery.test.ts` › "is cleared by a reopen and kept in history, and a close without a commit or pull request has none" |
| STATE-9 | `workers/api/test/engine/ready.test.ts` › "lists open epics with their children, eligible to close once every child is" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes as done in the same write, by Ntasks, naming the task that closed last, and clears its holder’s work" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes as done when any task under it closed as done, and as no longer needed when none shipped" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes a nested epic, then the epic above it when that was its last open task" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes an epic in the write that takes its keep-open label off" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "decides again when another task under the epic closes between its read and its batch" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes the epics above the 70 tasks one write closes together" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes an epic, naming the closed task that moved into it" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "closes the epic above when a close by a person replaces its own close of an epic under it" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "with no task under it, even once its only task moves out" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "labelled keep-open" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "reopens, with the epic above it, when a task under it reopens" |
| STATE-22 | `workers/api/test/engine/epics.test.ts` › "takes a close by an agent in place of its own, which a reopened task then leaves closed" |
| STATE-22 | `workers/api/test/access/github-webhook.test.ts` › "closes the epic above the task a merge closes when that was its last open task" |
| STATE-10 | `workers/api/test/api/write-tools.test.ts` › "opens an approval once, returning the open one when asked the same again" |
| STATE-10 | `workers/api/test/api/write-tools.test.ts` › "opens an approval with the title and Markdown description it is given" |
| STATE-10 | `workers/api/test/api/http-decisions.test.ts` › "hands back a waiting task labelled human, as an approval an agent relays does, and leaves a decision as it is" |
| STATE-10 | `workers/api/test/api/owner-answers.test.ts` › "refuses any relayed answer on a closed approval but the owner’s report, so a person’s approval stays as given" |
| STATE-11 | `workers/api/test/api/http-decisions.test.ts` › "closes a decision on the pick, past an open blocker and another holder" |
| STATE-11 | `workers/api/test/api/http-decisions.test.ts` › "hands a task that is not a decision back to ready work with the answer as a comment" |
| STATE-11 | `workers/api/test/api/http-decisions.test.ts` › "refuses a second pick, and finishes an interrupted one for the same person and option" |
| STATE-12 | `workers/api/test/api/delivery.test.ts` › "goes from built to merged with its merge commit, then live, and a repeated signal moves nothing" |
| STATE-12 | `workers/api/test/api/delivery.test.ts` › "matches a commit the task closed with when the signal names a longer one" |
| STATE-12 | `workers/api/test/api/delivery.test.ts` › "stops a task of a project that does not deploy at merged" |
| STATE-12 | `workers/api/test/api/delivery.test.ts` › "starts no delivery for a decision, and keeps a pull request it names as its link" |
| STATE-12 | `workers/api/test/api/delivery.test.ts` › "starts no delivery when it names only a link, whatever its work details name" |
| STATE-12 | `workers/api/test/access/github-webhook.test.ts` › "moves nothing when GitHub sends the same delivery again" |
| STATE-12 | `workers/api/test/access/github-webhook.test.ts` › "never moves a task back a stage" |
| STATE-12 | `workers/api/test/schema.test.ts` › "keeps a delivery on a task closed as done with a commit or pull request, and nowhere else" |
| STATE-13 | `workers/api/test/api/write-tools.test.ts` › "clears the helper and work details when the task closes or is released, and its history keeps them" |
| STATE-13 | `workers/api/test/api/write-tools.test.ts` › "updates the work from its holder’s comments, which move its last activity, and from nobody else’s" |
| STATE-13 | `workers/api/test/schema.test.ts` › "keeps a helper and work details only on a task someone holds that is not closed" |
| STATE-14 | `workers/api/test/api/write-tools.test.ts` › "opens a request the task waits on, with each step and its command stored apart, once" |
| STATE-14 | `workers/api/test/api/http-decisions.test.ts` › "records each tick with the person and the time, in any order, and frees the waiting task on the last" |
| STATE-14 | `workers/api/test/api/http-decisions.test.ts` › "marks where the person is stuck and why, tells the waiting task, and clears the mark on a tick" |
| STATE-14 | `workers/api/test/api/http-decisions.test.ts` › "refuses an approval of the request, a step it does not have and a closed request, writing nothing" |
| STATE-14 | `workers/api/test/engine/writes.test.ts` › "changes only the marks on its steps, never their text or commands, and only on a request" |
| STATE-14 | `workers/api/test/api/owner-answers.test.ts` › "closes on the owner’s report that they did the steps, and hands the waiting task back to agents" |
| STATE-15 | `workers/api/test/api/http-decisions.test.ts` › "closes the task as done by the person, whoever holds it, each criterion met or waived, with their reason" |
| STATE-15 | `workers/api/test/api/http-decisions.test.ts` › "closes with its own reason when the person gives none, and with no criteria on a task that has none" |
| STATE-15 | `workers/api/test/api/http-decisions.test.ts` › "refuses a criterion the task lacks, an unread or stale proposal, a closed task, a request and a task waiting on one, writing nothing" |
| STATE-15 | `workers/api/test/api/http-decisions.test.ts` › "is cleared by a reopen, whose history keeps it" |
| STATE-16 | `workers/api/test/api/read-tools.test.ts` › "names a held task stalled once its holder has done nothing on it for a day, or ever, and lists only those with stalled" |
| STATE-17 | `workers/api/test/api/write-tools.test.ts` › "pins a comment, and unpins earlier pinned comments of the same task, leaving its version" |
| STATE-17 | `workers/api/test/api/read-tools.test.ts` › "shows a task its epic's pinned comments and what its closed siblings left, newest first and capped" |
| STATE-17 | `workers/api/test/api/write-tools.test.ts` › "answers a claim on a task in an epic with the epic's pinned comments and its closed tasks' closes" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "closes the task whose work names the pull request as done by the merge, with its proof, at merged" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "leaves in progress a task labelled keep-open, an epic and a task with open tasks under it, saying why" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "leaves in progress a task that waits on an open approval or a request to do steps" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "closes nothing when the pull request that merged is one no task names" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "leaves in progress a task whose pull request merged when GitHub names no merge commit" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "closes a task once when GitHub sends the same merge again" |
| STATE-18 | `workers/api/test/access/github-webhook.test.ts` › "never closes a task in progress on a merge a sender reports through POST /api/delivery" |
| STATE-17 | `workers/api/test/schema.test.ts` › "lets a pinned comment be unpinned, and never pins an unpinned one again" |
| STATE-19 | `workers/api/test/api/write-tools.test.ts` › "lists the other work in progress that touches the same files, never refusing the claim" |
| STATE-20 | `workers/api/test/api/read-tools.test.ts` › "groups tasks in progress as active within the hour, quiet until a day and stalled after, and lists the groups asked for" |
| STATE-20 | `packages/domain/test/activity.test.ts` › "gives every activity case of the protocol its activity" |
| STATE-21 | `workers/api/test/api/read-tools.test.ts` › "groups tasks in progress as active within the hour, quiet until a day and stalled after, and lists the groups asked for" |
| AUTH-1 | `workers/api/test/api/http-decisions.test.ts` › "only a person signed in to the web app, whatever an agent or a service was granted" |
| AUTH-2 | `workers/api/test/access/approval.test.ts` › "keeps an agent named after the owner apart from the owner" |
| AUTH-2 | `workers/api/test/access/approval.test.ts` › "marks an owner whose own name starts like an agent’s, so the two never meet" |
| AUTH-3 | `workers/api/test/api/owner-answers.test.ts` › "keeps the record NoticeOS reads: who relayed it, the owner’s words, the question, the scope and the source" |
| AUTH-3 | `workers/api/test/api/owner-answers.test.ts` › "refuses an answer to a proposal that changed after the owner saw it, writing nothing" |
| AUTH-3 | `workers/api/test/api/owner-answers.test.ts` › "records a service’s answer only as relayed by the service, which cannot answer as a person" |
| AUTH-3 | `workers/api/test/api/http-decisions.test.ts` › "records an answer with the version its page showed, and refuses one whose proposal changed since, writing nothing" |
| AUTH-4 | `workers/api/test/api/owner-answers.test.ts` › "records the option the agent names and the quote as given, whatever the quote says" |
| AUTH-4 | `workers/api/test/api/http-decisions.test.ts` › "records a reply as given, never reading it as a pick of an option" |
| AUTH-5 | `workers/api/test/api/owner-answers.test.ts` › "reopens a relayed approval on the owner’s dispute, withdraws it, tells the waiting task, and refuses the old relay" |
| AUTH-5 | `workers/api/test/api/owner-answers.test.ts` › "refuses a dispute of a person’s direct approval, even after an agent relays that the owner did the action" |
| AUTH-6 | `workers/api/test/api/owner-answers.test.ts` › "declines one approval as wont-do, tells the task waiting on it, and keeps its other approval blocking" |
| AUTH-6 | `workers/api/test/api/owner-answers.test.ts` › "refuses the owner’s report on an approval whose request changed after it was approved" |
| AUTH-7 | `workers/api/test/api/owner-answers.test.ts` › "closes completed and obsolete requests with evidence and returns routine work to agents" |
| AUTH-7 | `workers/api/test/api/owner-answers.test.ts` › "closes an open approval on the owner’s own completed action, granting no future action" |
| AUTH-8 | `workers/api/test/api/write-tools.test.ts` › "refuses what the task state forbids: a new choice set, a shipped card, a human label, a held hand-over" |
| AUTH-8 | `workers/api/test/api/http-writes.test.ts` › "refuses a claim with other changes, a close by status, an assignee with spaces around it, and a human label taken off" |
| AUTH-9 | `workers/api/test/api/owner-answers.test.ts` › "releases an assignment only with checked inactivity, keeps its progress, and loses to a new holder" |
| AUTH-9 | `workers/api/test/api/owner-answers.test.ts` › "releases a dormant assignment and keeps blocked and deferred work as it was" |
| AUTH-9 | `workers/api/test/api/http-decisions.test.ts` › "frees a task on the person’s call, keeping who held it and where the work stopped in a comment" |
| AUTH-9 | `workers/api/test/api/http-decisions.test.ts` › "keeps a blocked task’s status, and refuses a task nobody holds and a closed one, writing nothing" |
| AUTH-9 | `workers/api/test/api/http-decisions.test.ts` › "refuses a free naming the holder the page showed once another agent holds the task, writing nothing" |
| AUTH-10 | `workers/api/test/api/write-tools.test.ts` › "refuses a project the sender may only read, and one it cannot reach as if it did not exist" |
| AUTH-10 | `workers/api/test/api/http-writes.test.ts` › "refuses fields that break their rules, a project it cannot reach and one it may only read" |
| AUTH-11 | `workers/api/test/api/http-decisions.test.ts` › "only a person signed in to the web app, whatever an agent or a service was granted" |
| AUTH-11 | `workers/api/test/api/owner-answers.test.ts` › "closes the task as done, accepted by the owner and relayed by the agent, each criterion met or waived" |
| AUTH-11 | `workers/api/test/api/owner-answers.test.ts` › "refuses one from a sender that acts for no person, such as a service, writing nothing" |
| AUTH-11 | `workers/api/test/api/owner-answers.test.ts` › "opens the task again on the owner’s dispute, tells the waiting task, and refuses the disputed source" |
| AUTH-11 | `workers/api/test/api/http-decisions.test.ts` › "needs an approval or an acceptance an agent recorded" |
| INV-1 | `workers/api/test/api/write-tools.test.ts` › "lets exactly one of two agents claiming at once take the task (rule 1)" |
| INV-1 | `workers/api/test/engine/writes.test.ts` › "lets exactly one of two agents that read the same version claim the task, and records nothing for the other" |
| INV-2 | `workers/api/test/api/read-tools.test.ts` › "names a held task stalled once its holder has done nothing on it for a day, or ever, and lists only those with stalled" |
| INV-3 | `workers/api/test/engine/writes.test.ts` › "answers a repeated write with the same result, without a second change" |
| INV-3 | `workers/api/test/engine/writes.test.ts` › "refuses a key reused for a different request, or in another project" |
| INV-3 | `workers/api/test/api/write-tools.test.ts` › "answers a retry with the same claim, and refuses the key for a different claim" |
| INV-3 | `workers/api/test/api/http-writes.test.ts` › "answers a retried change once, and refuses its key for the same change to another task" |
| INV-4 | `workers/api/test/engine/writes.test.ts` › "refuses a write based on an older version (rule 2)" |
| INV-4 | `workers/api/test/api/write-tools.test.ts` › "reads the task again when another write changed it first (rule 2), and gives up after a few tries" |
| INV-4 | `workers/api/test/schema.test.ts` › "refuses an update that does not raise the version by one" |
| INV-5 | `workers/api/test/schema.test.ts` › "writes nothing, history included, when the version has moved on" |
| INV-5 | `workers/api/test/engine/writes.test.ts` › "answers again once a refused write is retried with its key, as a new attempt" |
| INV-6 | `workers/api/test/schema.test.ts` › "never deletes a task" |
| INV-6 | `workers/api/test/schema.test.ts` › "never edits or deletes history" |
| INV-6 | `workers/api/test/schema.test.ts` › "never edits or deletes a comment" |
| INV-6 | `workers/api/test/schema.test.ts` › "lets a pinned comment be unpinned, and never pins an unpinned one again" |
| INV-6 | `workers/api/test/schema.test.ts` › "keeps a task in its project" |
| INV-7 | `workers/api/test/api/write-tools.test.ts` › "shows proof none on a task done with no commit, pull request or link, and warns its closer" |
| INV-7 | `workers/api/test/api/write-tools.test.ts` › "counts a link, a commit or pull request, or the ones its holder recorded, as proof, and exempts decisions and epics" |
| INV-7 | `workers/api/test/api/http-decisions.test.ts` › "closes the task as done by the person, whoever holds it, each criterion met or waived, with their reason" |
| INV-8 | `workers/api/test/engine/ready.test.ts` › "holds a task until every task blocking it is closed" |
| INV-9 | `workers/api/test/engine/writes.test.ts` › "reopens a closed task with no close left on it, and keeps the earlier close in history (rule 6)" |
| INV-10 | `workers/api/test/api/read-tools.test.ts` › "list each task the sender holds, most recently active first, with its helper, branch and next step, before the rules" |
| INV-10 | `workers/api/test/api/read-tools.test.ts` › "list ten of twelve, then how many more and the call that lists them, within the budget" |
| INV-11 | `workers/api/test/api/write-tools.test.ts` › "sets the one link between two tasks, changing blocks to related in one call, and removes it" |
| INV-11 | `workers/api/test/engine/ready.test.ts` › "refuses a blocks link that would close a loop, directly or through other tasks" |
| INV-11 | `workers/api/test/engine/ready.test.ts` › "refuses a parent that would make a task its own ancestor" |
| INV-11 | `workers/api/test/api/write-tools.test.ts` › "records which pull request merges first, on both tasks, holding neither out of ready work" |
| INV-12 | `workers/api/test/api/http.test.ts` › "reads its changes, newest first" |
| INV-12 | `workers/api/test/api/http.test.ts` › "names the closer and the claimer with the models they named" |
| INV-13 | `packages/domain/test/actors.test.ts` › "gives every actor in spec/naming.json its kind and display name: $actor" |
| INV-13 | `packages/domain/test/actors.test.ts` › "keys an agent and a person of the same name apart, and every spelling of one agent together" |
| INV-13 | `packages/domain/test/actors.test.ts` › "gives every model in spec/naming.json its id and display name: $model" |
| EXT-1 | `workers/api/test/engine/tasks.test.ts` › "merges metadata, removing a key set to null" |
| EXT-2 | `workers/api/test/engine/fields.test.ts` › "refuses a key the project has used, retired or not, and a definition that breaks a rule" |
| EXT-2 | `workers/api/test/engine/fields.test.ts` › "takes no new values, keeps the values tasks carry and their history, and lets a value be taken off" |
| EXT-2 | `workers/api/test/engine/fields.test.ts` › "refuses a value of the wrong type with a sentence naming the field and its type" |
| EXT-3 | `workers/api/test/api/read-tools.test.ts` › "names the argument a misnamed one most likely means" |
| EXT-3 | `workers/api/test/api/http.test.ts` › "refuses a parameter it does not take, a repeated one, and a missing or unknown project" |
| EXT-4 | `workers/api/test/schema.test.ts` › "refuses a type the model does not have" |
| EXT-4 | `workers/api/test/schema.test.ts` › "refuses a resolution the model does not have" |
| EXT-4 | `workers/api/test/schema.test.ts` › "refuses a history event kind the model does not have" |
| VER-3 | `workers/api/test/api/write-tools.test.ts` › "offers NoticeOS's task tools with every argument they took, requiring none they did not" |
| MCP-1 | `workers/api/test/api/read-tools.test.ts` › "list ten of twelve, then how many more and the call that lists them, within the budget" |
| MCP-2 | `workers/api/test/api/write-tools.test.ts` › "answers the same new task sent again without a key with its first result, while it is unchanged and for a day" |
| MCP-2 | `workers/api/test/api/write-tools.test.ts` › "runs the same write sent again without a key once the task has changed since its answer" |
| MCP-3 | `workers/api/test/api/read-tools.test.ts` › "refuses a call that names no workspace from a sender who reaches several, listing them" |
| HTTP-1 | `workers/api/test/api/http.test.ts` › "refuses a parameter it does not take, a repeated one, and a missing or unknown project" |

## Rules with no test, or part of one

Each of these is a gap in Ntasks's own tests today. The conformance suite
checks most of them from outside; `pnpm --filter @ntasks/spec run
conformance -- --list` lists its checks by rule.

| Rule | What no test covers |
|---|---|
| STATE-2 | That a server never sets `blocked` because of a link |
| STATE-4 | A claim refused for a `deferred` task, and for one `in_progress` with nobody holding it ([OQ-3](open-questions.md#oq-3)) |
| STATE-7 | A commit or a pull request refused on a close that is not `done`; only a link is tried |
| INV-2 | That no time longer than a day releases a claim: the test reads a claim a day after its last activity |
| INV-4 | The `503` with `unavailable` over HTTP after the rereads run out |
| INV-7 | That an approval closes without proof, and that each of bug, feature and chore needs it ([OQ-8](open-questions.md#oq-8)) |
| INV-12 | The model recorded in a history event ([OQ-16](open-questions.md#oq-16)) |
| VER-1, VER-2 | Rules of this document, which the schema test checks for the `$id`s |
