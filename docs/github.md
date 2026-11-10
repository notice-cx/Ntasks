# Connect GitHub

Connect GitHub once, and each task your agents close with a pull request
moves on by itself: to **Merged** when the pull request merges, and to
**Live** when its deploy passes. No agent reports either step, so a task
moves on even after the agent that did the work has stopped.

A workspace's owner connects it on the web app's **Settings** page. It takes
one button and an install on each GitHub account or organization whose
repositories your agents work in.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/walkthrough-shipped-dark.webp">
  <img src="images/walkthrough-shipped-light.webp" width="800" alt="Waiting for you lists work waiting for merge and for deploy, then the Done view shows tasks marked Built, Merged and Live, and one marked No proof.">
</picture>

The site's [Built to live diagram](https://ntasks.notice.cx/#built-to-live)
shows a task going through the three stages.

## Connect it

1. In **Settings**, under **GitHub**, press **Connect GitHub**.
2. On GitHub, press **Create GitHub App**. GitHub makes an app for the
   workspace and returns you to Ntasks, which opens the app's install page
   for your own GitHub account.
3. Choose **All repositories** and press **Install**.

For each organization, press **Install on an organization** in Settings, pick
the organization, and press **Install**. Installing on an organization takes
an owner of it on GitHub.

Settings then lists each account and organization under **Installed on**.
You copy no secret, add no webhook and type no name.

Install the app while signed in to GitHub with the account you sign in to
Ntasks with. Ntasks reads events only from installations a workspace owner
made, because anyone can install a public GitHub App.

## What moves a task

A task starts at **Built** when an agent closes it as done with its pull
request or commit ([Where a change is](concepts.md#where-a-change-is)).
GitHub's events move it from there:

| On GitHub | The task moves to |
|---|---|
| Its pull request merges into the repository's default branch | Merged |
| A deploy of the merge passes | Live |

- **A deploy** is a passing check whose name starts with `Workers Builds:` or
  `Cloudflare Pages`, the checks Cloudflare's builds report, or a successful
  deployment to the production environment. Settings lists each deploy it
  has seen under **Deploys**, with a box that switches it off. A deploy
  switched off moves no task.
- **A project that deploys.** The first deploy seen for a project's tasks
  turns on **Changes go live by a deploy** for that project, on the Projects
  page. A project with no deploy, such as a library, stops at Merged. An
  owner who turns the setting off keeps it off.
- **A pull request merged before its task closed.** Its merge event came too
  early to move the task, so Ntasks asks GitHub about 5 seconds after the
  close, and moves the task to Merged then. Installing the app does the same
  for tasks already waiting for a merge, such as those closed before GitHub
  was connected.

## Check that it works

Close a task with a pull request and merge the pull request. The task leaves
**Waiting for merge** in Waiting for you, and the Done view marks it Merged.
After its deploy passes, it shows Live.

GitHub keeps each event the app sent, with Ntasks's answer, on the app's
page on GitHub, under **Advanced**, **Recent Deliveries**. An event that
moved nothing names why, such as a check that is not a deploy.

## Disconnect

In Settings, under GitHub, press **Disconnect**. Ntasks forgets the app and
its installations and refuses its events from then on. The app stays on
GitHub until you delete it there, on the app's page under **Advanced**.

## Without the app

- A webhook added to a repository or an organization by hand:
  [Set up by hand](api.md#set-up-by-hand), under Settings, GitHub.
- A workflow that sends the signals itself, for a deploy GitHub doesn't
  report: [Delivery](api.md#delivery) has one.

The [API](api.md#from-github) gives the full rules: the events the app
receives, how each delivery is checked, and every answer.
