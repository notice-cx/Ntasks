# The web app

The pages people use, and animated walkthroughs of its main features, drawn
from the web app's invented example data. Regenerate the pictures with
`pnpm screenshots` and the walkthroughs with `pnpm screenshots walkthroughs`
([tools/screenshots](../tools/screenshots/README.md)).

## Pages

**Tasks board.** Waiting for you, answered on each row, then every task by status.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/board-dark.webp">
  <img src="images/board-light.webp" width="800" alt="The Tasks board: the sidebar, then Waiting for you with Approve, option and Answer buttons on its rows, then the In progress, Open, Blocked, Parked and Done groups.">
</picture>

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

### Approve exactly what you saw

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-approve-dark.webp">
  <img src="images/walkthrough-approve-light.webp" width="800" alt="An approval names its action, environment, scope and verification; the cursor approves it and the task shows Done, Approved; then an approval Claude recorded for a person shows the person's words and a Dispute button.">
</picture>

An approval covers the action, environment and scope you read, and nothing
beyond it. An answer an agent relays from a chat shows your words, and you
can dispute it.

### Set it up in one step

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-setup-dark.webp">
  <img src="images/walkthrough-setup-light.webp" width="800" alt="On a new deployment's setup page, the cursor types the AUTH_SECRET, which shows masked, and presses Create the GitHub App.">
</picture>

A new deployment asks for one secret. Its first page creates the GitHub app
people sign in with.
