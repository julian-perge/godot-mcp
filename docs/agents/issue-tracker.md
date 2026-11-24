# Issue tracker: GitHub

Tasks for this repo are GitHub issues. Read them with the `agent-skills` verbs, which [Workflow](workflow.md) lists, and write them with the `gh` CLI. Pass `--repo julian-perge/godot-mcp` on every write: in a fork with an `upstream` remote, a bare `gh` can target the parent repo.

## Conventions

- **Read an issue**: `agent-skills issue <n>`.
- **Read a pull request**: `agent-skills pr <n>`.
- **List issues**: `gh issue list --state open --json number,title,body,labels` with `--label` filters.
- **Multi-line bodies**: `--body-file -` with a heredoc.

## Sub-issues and blocking

- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+).
- **Blocking**: GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. `<blocker-db-id>` is the blocker's numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), not the `#number` and not the `node_id`.
- **One record of blocking**: native dependencies are the only record of what blocks a task. `agent-skills issue <n>` lists a task's open blockers.
- **Frontier**: `agent-skills frontier <parent>`. The frontier is the parent's lowest open sub-issue that has the `ready-for-agent` label, no open blocker and no assignee.
- **Claim**: `agent-skills claim <n>`, as the session's first write. It assigns `@me` and makes the branch.
