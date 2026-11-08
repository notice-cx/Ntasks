# Why Ntasks

The problems people and AI coding agents run into when they share work, where
each one was reported, and what Ntasks does about it.

The list comes from three inputs, gathered in November 2026:

- retrospectives from five working sessions of our own coding agents (Claude
  and Codex), each comparing the agent's built-in task list with a shared task
  hub;
- interviews with developers about working with their agents;
- about 60 public reports from 2025 and 2026: GitHub issues, Hacker News
  threads, forum posts, blog posts and vendor documentation.

A problem counts as a pattern when three or more independent public sources
report it. Complaint threads over-represent failures, so the counts measure
the sources found, not how common a problem is.

## Agents lose finished work and decisions between sessions

After a new session or a context compaction, agents redo committed work and
reopen settled decisions, and the person ends up remembering for them. 12
independent public sources report it.

- A Claude Code user logged seven sessions in two weeks where the agent
  re-implemented fixes already committed
  ([claude-code#39961](https://github.com/anthropics/claude-code/issues/39961)).
- After each compaction, Codex went back to earlier phases and reopened
  resolved decisions, using a week's allowance in about two hours
  ([codex#35935](https://github.com/openai/codex/issues/35935)).
- People keep handoff, log and decision files by hand to work around it
  ([Ask HN: your agentic setup](https://news.ycombinator.com/item?id=50366117)).

**What Ntasks does.** Each held task keeps its live work: the helper agent,
branch, pull request, commit and next step. When an agent connects, Ntasks
tells it which tasks it holds and the next step of each.

## "Done" that isn't done

Agents mark work complete without doing it or checking it, so every "done"
needs a person to check it. 11 independent public sources report it.

- Todo items were checked off although the integration was never written
  ([claude-code#14947](https://github.com/anthropics/claude-code/issues/14947)).
- Anthropic's documentation for Claude Code agent teams lists two known
  limits: teammates sometimes fail to mark tasks completed, and the lead can
  decide the team is finished before all tasks are done
  ([agent teams](https://code.claude.com/docs/en/agent-teams#limitations)).
- In the Stack Overflow 2025 developer survey, 66% name AI answers that are
  "almost right, but not quite" as a frustration
  ([survey](https://survey.stackoverflow.co/2025/ai)).

In four of our five agent sessions, a closed task did not show whether its
change was merged or deployed.

**What Ntasks does.** A closed task records its proof: a commit, a pull
request or a link. It shows whether its change is built, merged or live, and
a repository's merge and deploy signals move it on. A task closed as done
with no proof says "No proof".

## Nobody can see what each agent is doing

With several agents running, people lose track of which one works on what,
which one waits for them, and what each helper agent returned. 13 independent
public sources report it.

- With several sessions open, nothing shows which one is blocked on a
  question ([claude-code#36885](https://github.com/anthropics/claude-code/issues/36885)).
- A developer asks for a task board built for agents, because terminal logs
  are unmanageable
  ([Ask HN: control plane](https://news.ycombinator.com/item?id=47242849)).
- GitHub ([changelog](https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/))
  and Linear ([guide](https://linear.app/enablement/guide/ai-agents)) now
  show agent sessions on issues.

In one of our sessions, helper agents could not reach the task hub, so their
coordinator claimed their tasks for them 11 minutes after they had started.

**What Ntasks does.** Every task shows who holds it, the helper agent doing
the work, and its last activity. Everything that needs a person is in one
list, Waiting for you.

## Review is the bottleneck

Agents running in parallel finish changes faster than a person can review and
ship them. 9 independent public sources report it.

- Simon Willison names how fast he can review the results as the limit of
  running agents in parallel
  ([simonwillison.net](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/)).
- Large discussion threads report validation, not generation, as the limit
  ([Hacker News](https://news.ycombinator.com/item?id=47218318),
  [Hacker News](https://news.ycombinator.com/item?id=48239413)).

**What Ntasks does.** Waiting for you lists the decisions and approvals
waiting for you, the work built and waiting to merge, and the work merged and
waiting to deploy.

## Decisions given in chat leave no reliable record

In two of our five agent sessions, an approval the owner gave in chat could
not be recorded, and in one the approval stayed open after the approved work
had passed its check. Public reports on approvals concern approving each tool
action an agent takes: Anthropic reports that Claude Code users approve 97%
of permission prompts
([Claude blog](https://claude.com/blog/auto-mode-default-in-claude-code)).

**What Ntasks does.** A person answers a decision or an approval with one
button, on the exact proposal they saw. An agent relaying an answer from a
chat records the option, the person's words and where they said them, and
the person can dispute it.

## Task tools are heavy, and their bookkeeping fills the agent's context

Dedicated agent trackers take hours to install, upgrade and repair, and
general trackers feel slow and built for people only. 11 independent public
sources report it. Task-tracking calls, tool definitions and long replies also
use up the agent's context and plan limits, which 10 sources report.

- A Beads user spent 9.5 hours maintaining the tool rather than using it
  ([beads#2938](https://github.com/gastownhall/beads/issues/2938)).
- Thoughtworks' Technology Radar (November 2026) places Beads in Trial and
  notes it has grown heavier than the light tracker it began as
  ([Radar](https://www.thoughtworks.com/en-au/radar/tools/beads)).
- Anthropic's guidance for agent tools asks for fewer tools that combine
  steps, readable names, short replies and errors that say how to fix them
  ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

In our agent sessions, a small fix took four to six task calls, one agent
pasted the same two long ids into all 56 of its calls, and claim and close
replies returned up to 13,000 characters each.

**What Ntasks does.** Nothing is installed in your repositories: agents
connect to one address over MCP. A call needs only a task id. Claiming,
commenting and closing are one call each, and can cover many tasks at once.
Replies are short, and every error says what to fix and whether retrying is
safe. A new deployment asks for one secret.
