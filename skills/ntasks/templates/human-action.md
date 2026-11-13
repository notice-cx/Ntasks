<!-- Pass the existing task ID as task and the first heading as title to request_human_action. Put the opening sentence and the What it changes and How we'll confirm sections in context. Pass Your steps as the structured steps array. Each step needs text. Put a runnable command or query in that step's command field. -->

# [Verb + the outcome the person will complete]

[Ask the person to act. Name where they act and why their access or role is needed.]

## What it changes

- **[Impact]** [Say who or what it affects. Give values with units where applicable.]

## How we'll confirm

[Say what the agent will check after the person finishes.]

## Your steps

1. [One action to take and where to take it.]
2. [The next action or where to record the result.]

<!-- The person ticks the steps in Ntasks. The last tick closes the request and removes it as a blocker on the linked task. Verify the result before continuing or closing that task. Use request_human_approval when the agent needs permission to act, or the decision template when the person needs to choose. -->
