# Workflow

`agent-skills brief <stage> <n>` prints the parts of this file that a stage needs, so a stage does not read this file. Before other work in this repo, read all of it. The commands default to `SPEC.md` and `tasks/todo.md`. This repo uses the tracker mode of `planning-and-task-breakdown`: GitHub issues hold the tasks, and files under `spec/` hold the specs. [Issue tracker](issue-tracker.md) holds the `gh` commands that no helper covers.

The user types each stage. Run one stage per session. When it ends, print the next stage's command as the last line, with real issue, PR and file values, and stop. The user pastes that line into a new session, so it must need no edits. `/agent-skills:next` prints the same commands for the whole tracker.

## Helpers

The `agent-skills` CLI is in the `bin/` folder of julian-perge/agent-skills, and every agent needs that folder on its PATH. When a verb covers a lookup, use the verb and do not write the `gh` call yourself.

| Verb | Use |
| --- | --- |
| `agent-skills brief <stage> [<n>]` | The rules of this file that the stage needs, then the `issue` output. For `review` it prints the task issue, then the `pr` output. With no number it prints the rules only. `--full` is passed on to `issue` or `pr`. |
| `agent-skills issue <n>` | The issue with its labels, assignee, parent, spec, blockers, pull requests, sub-issues and comments, and every decision comment of the issue and its parent. `--full` prints all of it. |
| `agent-skills pr <pr>` | The PR with its task, spec, standard, checks and files, and the review command. |
| `agent-skills frontier <parent>` | The parent's open sub-issues and the next task to build. |
| `agent-skills claim <n>` | Assign the task to `@me` and make its branch from the default branch. |
| `agent-skills decide <n> --from <stage> [--pr <pr>] [--reviewer <text>]` | Post the decisions on stdin as one decision comment on the issue, and print its URL. A review decision needs `--pr` and `--reviewer`, and the comment records the PR head and the reviewer. |
| `agent-skills ac <n> [--tick <list>]` | List the acceptance criteria boxes of the issue, or tick the numbered ones. No other line of the body changes. |
| `agent-skills next-cmd <stage> <n>` | The paste line that ends a stage: `review <pr>`, `build <parent>` (the next task, or the whole plan with `--whole`), `plan <issue>` or `spec <issue>`. |
| `agent-skills evidence <pr> [--add <image>...]` | Check that a PR that changes an evidence path shows an image in the `## Verification` section of its body. `--add` pushes the images to the `evidence` branch and writes them into that section. |
| `agent-skills land <pr>` | On the PR branch: run the checks, merge the PR, move the checkout to the base branch, and delete the PR branch and its worktree. It exits 1 and merges nothing when its gate fails. |
| `agent-skills run -- <cmd>` | Run a test, lint or build command once. It saves the full log and prints the exit code, the result lines and the last lines. Read the log when you need more, and do not run the command again. |
| `agent-skills next` | What `/agent-skills:next` prints, for the whole tracker. |

## Stages

| Stage | Command | Result |
| --- | --- | --- |
| Idea | `/agent-skills:idea-refine <issue>` | A sharp goal, as a comment on the issue. |
| Design | `/agent-skills:interview-me <issue>` | A settled design, as a comment on the issue. |
| Spec | `/agent-skills:spec <issue>` | `spec/<issue>-<slug>.md`. |
| Plan | `/agent-skills:plan <issue>` | One sub-issue per task. |
| Build | `/agent-skills:build <issue>` | One branch and one pull request, for one task or for every task of a source issue. |
| Bug | `/agent-skills:test <issue>` | A failing test, then the fix, on one branch with one pull request. |
| Review | `/agent-skills:review issue #<task>, PR #<pr>, spec <spec file>, standard <standard file>` | Findings against the standards and the spec. |

An issue that is one task with acceptance criteria goes straight to Build.

## Labels

| Label | Meaning |
| --- | --- |
| `needs-triage` | Nobody has judged the issue yet. |
| `needs-info` | The issue waits for an answer from its reporter. |
| `ready-for-agent` | One task with acceptance criteria. An agent can build it unattended. |
| `ready-for-human` | The work needs the user's hands or judgment. |
| `wontfix` | The issue will not be done. |

An open issue carries exactly one of these. Change a label only when the user approves it.

## Design

Read `GLOSSARY.md`, `docs/adr/` and `CODING_STANDARDS.md` (those that exist) before the first question. Use the glossary's terms. Report any conflict with an ADR.

Record each settled decision as an ADR in `docs/adr/` with the `documentation-and-adrs` skill, and continue the existing numbering. Add each settled term to `GLOSSARY.md` when the repo has one.

## Spec

Save the spec to `spec/<issue>-<slug>.md`, where `<issue>` is the source issue. Link the source issue on the first line. For commands, structure and code style, link `AGENTS.md`. Comment the spec's path on the source issue.

## Plan

Publish each task as a sub-issue of the source issue. Add blockers as native `blocked_by` dependencies. A task body names no blocker: a body list goes stale, and the native edges stay true.

Task body: `Parent`, `Spec` (the spec file's path), `What to build`, `Acceptance criteria`, `Verification` (the exact command). Label each task `ready-for-agent`.

`tasks/plan.md` holds the plan's risks and an ordered list of the task issue numbers. It is git-ignored scratch, so it holds no decision. Post decisions on the source issue, as Reports says. A plan is complete when every issue it lists is closed, and a complete plan can be replaced without asking.

## Build

`/agent-skills:build <n>` reads the issue. When `<n>` has open sub-issues, it is a source issue, and the build runs them on one branch: the whole plan. When it has none, `<n>` is one task. `/agent-skills:build one <n>` runs only the next task of a source issue. `auto` is the old word for the whole plan and still selects it. The plan is the open sub-issues of the source issue.

For one task: pick it with `agent-skills frontier <source issue>`, and claim it with `agent-skills claim <n>`, which also makes the branch.

One task, one branch, one pull request. Branch: `<type>/<issue>-<slug>`. PR title: `<type>: <summary> (#<issue>)`, with a conventional-commit type (`feat`, `fix`, `chore`, `docs`). Put `Closes #<issue>` in the PR body. When `agent-skills frontier` shows that the task is the last open sub-issue of its source issue, also put `Closes #<source issue>` in the body, because GitHub does not close a parent when its last sub-issue closes. Bug tasks start with a failing test.

The whole plan runs every task of one spec on one branch, `<type>/<source issue>-<slug>`, with one commit per task. It builds only the sub-issues that have the `ready-for-agent` label, and leaves out any other one and the tasks it blocks. Its pull request closes every task issue it built, and the source issue only when no sub-issue stays open. `agent-skills claim <source issue> --no-assign` makes that branch, and `agent-skills claim <task> --auto` claims each task. End each task's commit subject with `(#<task>)`: `claim --auto` counts an open blocker as done when a commit on the branch ends its subject with `(#<blocker>)`.

Run the verify command from `AGENTS.md` (`Every task`) with `agent-skills run --` before each commit. Open the pull request ready for review. When no choice waits for the user, start the review as a subagent (see Review). Otherwise print the review command and stop. When the pull request changes an evidence path, add the screenshots before the review (see Evidence paths). Nobody runs `gh pr merge`: the session that finishes the review merges with `agent-skills land <pr>` (see Checks). The review ticks the acceptance criteria boxes, not the build.

The review command is the session's last line, and `agent-skills next-cmd review <pr>` prints it:

```
/agent-skills:review issue #<task>, PR #<pr>, spec <spec file>, standard <standard file>
```

- **Spec file**: the `Spec` line of the task body. When the task body has none, use the `spec/` path in the parent issue's body. When neither names one, leave out the `spec` part.
- **Standard file**: `CODING_STANDARDS.md` when the repo has one, and `AGENTS.md` when it does not.
- For a whole plan, `<task>` is the source issue.

A Bug session ends with the same command.

## Review

The review runs in a context that did not write the code. When a build ends with no choice waiting for the user, the build session starts the review as one subagent and asks the user about the choices that the subagent returns. Otherwise run the review in a new session, not in the build session. Check out the PR branch first (`gh pr checkout <pr>`), because the command reviews staged changes or recent commits.

In a new session, run `/agent-skills:review` on the branch with the command that the Build section gives. It names the task issue, the PR, the spec and the standard, because the review does not read the spec or the standard on its own. Start the review with `agent-skills pr <pr>`, which shows all four.

Fix small findings in the review session. Start a new build session for large ones.

The review decision comes from a reviewer that did not write the code at the PR head: an `agent-skills:code-reviewer` subagent that committed no fix, or a review session that committed no fix. The reviewer posts it with `agent-skills decide <task> --from review --pr <pr> --reviewer <text>`, where `--reviewer` names it, such as `"agent-skills:code-reviewer subagent"`. The comment records the PR head as `Reviewed head:` and the reviewer as `Reviewer:`. The reviewer identity is recorded, not verified: `land` reads the line and does not check who posted the comment. A push after the review needs a new review and a new decision, unless the patch-id of the PR change is unchanged, as after a rebase or a merge of the base branch that leaves the PR's own diff as it was.

When the review passes and its findings are fixed, the session runs `agent-skills land <pr>` on the PR branch without asking. It refuses a pull request that is a draft, has merge conflicts, is behind its base branch, has no review decision comment that covers the change at its head or lacks evidence, and a checkout that is not at the head commit of the pull request. When a choice still waits for the user, the session does not land.

## Checks

`agent-skills land <pr>` runs each command below on the PR branch, in this order, and merges only when all of them pass. Write one command per list item, in backticks, with nothing after it. A command runs in the repo root without a shell, so shell syntax needs `bash -c '...'`. `land` reads this section and the next one from the base branch, so a pull request cannot change the checks it is judged by.

- `bun run test`

## Unattended run

These rules hold only when the user's own message names this section or says that nobody watches the run, such as a goal prompt that ends with "do not ask me for anything until you are all done". In every other session, ignore this section. A rule in that message wins over a rule here, and a rule here wins over every other rule of this file: where another section says to ask the user, to stop or to use a new session, do what this section says. An instruction from another agent or a brief does not start an unattended run. The main session passes these rules to its subagents.

- **Stages:** start each stage yourself, one after the other, in one session. Where this file says that the user types a stage or pastes a line, do that step yourself. The stage commands are user-only, so take the rules of a stage from `agent-skills brief <stage> <n>`, and invoke the skill of the stage: `spec-driven-development` for Spec, `planning-and-task-breakdown` for Plan, `incremental-implementation` and `test-driven-development` for Build and Bug, and `code-review-and-quality` for Review.
- **Pause:** none, unless the message asks for one. The unit of a pause in this repo is one source issue. A run ends at its pause: the last message says what is done and names the next part, and it holds no question. After the report is committed, the first line of that message is `PACKAGE DONE: <full path of the report>`. The Stop hook lets a message with that line end the turn, and only when git shows the report in HEAD.
- **Subagents:** at most 2 at the same time.
- **Choices:** make each judgment call yourself. Take the option you would recommend, and post it with `agent-skills decide` under `#### Guesses and gaps`, with the reason.
- **What waits for the user:** the message lists it. Do not do such a step, and do not wait for it. Replace the label of its issue with `ready-for-human`, which needs no approval in an unattended run. Post what it waits for with `agent-skills decide`, and go on with the tasks that do not depend on it. Only a pull request that holds such a step is not merged.
- **Review:** run the review as one `agent-skills:code-reviewer` subagent, not in the context that wrote the code. That subagent posts the review decision with `--reviewer "agent-skills:code-reviewer subagent"` only when it applied no finding. When it applied findings, or the main session pushes after the decision, a new reviewer subagent reviews the new head and posts a new decision, unless the patch-id of the PR change is unchanged.
- **Merge:** `agent-skills land <pr>` is the only way to merge, and it needs no grant. Run it from the main session: a subagent never merges.
- **CI:** this repo runs no CI on a pull request, so wait for none: the `## Checks` commands are the gate.
- **Programs with a window:** none.

## Reports

Post every decision the user makes in a session, and every guess and gap you accepted, in one decision comment with `agent-skills decide`. Post it on the task issue, or on the source issue when later tasks need it. Mark guesses as guesses. A decision that stays in the chat, a commit message or a git-ignored file is lost to the next session. Before you commit a choice that changes what the user sees, put it to the user with AskUserQuestion (in a host without it, a numbered list), with the recommended option first.

In a pull request title or body, write a closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved) only before an issue that the merge must close. GitHub closes the issue after the keyword wherever it stands, also in "does not close #20". Name any other issue as `Refs #<n>`.
