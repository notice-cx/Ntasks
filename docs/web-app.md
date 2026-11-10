# The web app

The pages people use, and animated walkthroughs of its main features, drawn
from the web app's invented example data. Regenerate the pictures with
`pnpm screenshots` and the walkthroughs with `pnpm screenshots walkthroughs`
([tools/screenshots](../tools/screenshots/README.md)).

## Pages

**Tasks board.** Waiting for you, answered on each row, then every task by
status. The Sort menu orders each group by priority, creation, last change,
close or title, either way, and the address keeps the order.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/board-dark.webp">
  <img src="images/board-light.webp" width="800" alt="The Tasks board: the sidebar, then Waiting for you with Approve, option and Answer buttons on its rows, then the In progress, Open, Blocked, Parked and Done groups.">
</picture>

**Epics.** With one project in view, the Epics tab lists the project's open
epics, one line each, grouped by what they need: Waiting for you, Moving, Not
moving, Every task done and No tasks. Each line shows how many of its tasks
wait for you or are blocked, a bar of its tasks by status, its tasks done of
all, and how many closed this week, counting its sub-epics' tasks too.

**Task page.** Markdown text, Done when, activity and the task's facts.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/task-dark.webp">
  <img src="images/task-light.webp" width="800" alt="The page of the bug web-b2r6: its description with headings, lists and a code block, a Done when checklist, activity and a comment box, beside a panel of its status, priority, assignee, type, project, epic and labels.">
</picture>

**Focus.** The decisions waiting for you, one at a time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/focus-dark.webp">
  <img src="images/focus-light.webp" width="800" alt="Focus on the decision web-d4x1: three options keyed A, B and C, a Note field, Not now and Answer.">
</picture>

**Live.** Every task in progress, grouped by when its holder last changed or
commented on it: Active, Quiet and Stalled. In each group a task sits under
its epic, with the epic's progress bar.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/live-dark.webp">
  <img src="images/live-light.webp" width="800" alt="The Live page: 1 active, 1 quiet and 1 stalled at the top beside Stalled after 1 day, then the Active, Quiet and Stalled groups, each row with its task's next step, pull request or branch, helper, holder and how long since the holder's last change.">
</picture>

**Productivity.** What you and your agents got done that matters, day by
day: changes merged or live, decisions you answered and epics finished, with
a strip of the last seven days at the top. It counts no tasks closed, and
reads back eight weeks.

**Phone.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/phone-dark.webp">
  <img src="images/phone-light.webp" width="320" alt="The Tasks board at phone width, with each waiting row's answer on a line under its title.">
</picture>

**Sign-in and agent approval.** Pages the Worker serves itself.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/sign-in-dark.webp">
  <img src="images/sign-in-light.webp" width="380" alt="The sign-in page: the Ntasks logo, Sign in to Ntasks and a Sign in with GitHub button.">
</picture>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/agent-access-dark.webp">
  <img src="images/agent-access-light.webp" width="380" alt="The agent approval page: the agent's name and address, the access it asks for, the account, where the answer returns to, a project checklist, Deny and Allow.">
</picture>

## Walkthroughs

### Answer a decision

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-decide-dark.webp">
  <img src="images/walkthrough-decide-light.webp" width="800" alt="The cursor picks the recommended option of a decision in Waiting for you, the decision leaves the list, and the task that waited on it moves from Blocked to Open with its Claim button.">
</picture>

Pick an option and answer. The work your decision held becomes ready for an
agent to claim.

### See who works on what

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-live-work-dark.webp">
  <img src="images/walkthrough-live-work-light.webp" width="800" alt="A held task's row shows the helper its agent works for and its last activity; the cursor opens it, and the page shows the assignee, last activity, next step, branch and pull request.">
</picture>

Each task shows the agent that holds it, the helper doing the work, its
branch, its pull request, its next step and when it last moved.

### Know what shipped

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-shipped-dark.webp">
  <img src="images/walkthrough-shipped-light.webp" width="800" alt="Waiting for you lists work waiting for merge and for deploy, then the Done view shows tasks marked Built, Merged and Live, and one marked No proof.">
</picture>

Work closed with a commit or a pull request shows whether its change is
built, merged or live, moved on by the merge and deploy signals your
repository sends ([Delivery](api.md#delivery)). Work closed with no proof
says so.

**Done, my call** in the Close menu closes a task as done on your own
judgement. Its form lists each line of Done when as a box: you tick the
criteria that are met, and the rest are recorded as waived, with your reason.
The task then shows who accepted it and what they waived. Only a person can
close a task this way; an agent that records your acceptance from a chat is
shown as having relayed it, and you can dispute it.

### Approve exactly what you saw

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-approve-dark.webp">
  <img src="images/walkthrough-approve-light.webp" width="800" alt="An approval names its action, environment, scope and verification; the cursor approves it and the task shows Done, Approved; then an approval Claude recorded for a person shows the person's words and a Dispute button.">
</picture>

An approval covers the action, environment and scope you read, and nothing
beyond it. An answer an agent relays from a chat shows your words, and you
can dispute it.

### Tick off your steps

When an agent needs something only you can do, such as running a command on
your own machine, it asks for your steps. Each step is a box to tick, with its
command as a block to copy. Tick them in any order, leave a note when the
agent asked for a value, or press **Stuck here** and say why. Ticking the last
step hands the waiting task back to the agent, which checks the result before
it continues.

### Set it up in one step

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-setup-dark.webp">
  <img src="images/walkthrough-setup-light.webp" width="800" alt="On a new deployment's setup page, the cursor types the AUTH_SECRET, which shows masked, and presses Create the GitHub App.">
</picture>

A new deployment asks for one secret. Its first page creates the GitHub app
people sign in with.
