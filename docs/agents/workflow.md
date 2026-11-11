# Workflow

Read this before any `/agent-skills` command. The commands default to `SPEC.md` and `tasks/todo.md`. This repo uses the tracker mode of `planning-and-task-breakdown`: GitHub issues hold the tasks, and files under `spec/` hold the specs. [Issue tracker](issue-tracker.md) holds the `gh` commands.

The user types each stage. Run one stage per session. When it ends, name the next stage and stop.

## Stages

| Stage | Command | Result |
| --- | --- | --- |
| Idea | `/agent-skills:idea-refine <issue>` | A sharp goal, as a comment on the issue. |
| Design | `/agent-skills:interview-me <issue>` | A settled design, as a comment on the issue. |
| Spec | `/agent-skills:spec <issue>` | `spec/<issue>-<slug>.md`. |
| Plan | `/agent-skills:plan <issue>` | One sub-issue per task. |
| Build | `/agent-skills:build <task issue>` | One branch, one pull request. |
| Bug | `/agent-skills:test <issue>` | A failing test, then the fix, on one branch with one pull request. |
| Review | `/agent-skills:review` | Findings against the standards and the spec. |

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

Task body: `Parent`, `What to build`, `Acceptance criteria`, `Verification` (the exact command). Label each task `ready-for-agent`.

`tasks/plan.md` holds the plan's decisions, risks and an ordered list of the task issue numbers. It is git-ignored scratch. A plan is complete when every issue it lists is closed, and a complete plan can be replaced without asking.

## Build

`/agent-skills:build` reads one argument, `auto`. Any other text selects single-task mode, so the task issue number you type is context. The plan is the open sub-issues of the source issue.

Pick the task with the **frontier query** in [Issue tracker](issue-tracker.md). Claim it with `gh issue edit <n> --add-assignee @me`.

One task, one branch, one pull request. Branch: `<type>/<issue>-<slug>`. PR title: `<type>: <summary> (#<issue>)`, with a conventional-commit type (`feat`, `fix`, `chore`, `docs`). Put `Closes #<issue>` in the PR body. Bug tasks start with a failing test.

`/agent-skills:build auto` runs every task of one spec on one branch, `<type>/<source issue>-<slug>`, with one commit per task. Its pull request closes every task issue.

Run the verify command from `AGENTS.md` (`Every task`) before each commit. Open the pull request and stop. The user merges.

## Review

Run `/agent-skills:review` on the branch. Give it the task issue and the spec file as the spec. Name `CODING_STANDARDS.md` as the standard when the repo has one, and `AGENTS.md` when it does not. The review does not read either on its own.

## Reports

Report every guess and every gap you accepted. Put any choice that changes user-visible behavior to the user before you commit.
