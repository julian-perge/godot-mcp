# Issue tracker: GitHub

Tasks for this repo are GitHub issues. Use the `gh` CLI. Pass `--repo julian-perge/godot-mcp` on every write: in a fork with an `upstream` remote, a bare `gh` can target the parent repo.

## Conventions

- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels` with `--label` filters.
- **Multi-line bodies**: `--body-file -` with a heredoc.

## Sub-issues and blocking

- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+).
- **Blocking**: GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. `<blocker-db-id>` is the blocker's numeric database id (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), not the `#number` and not the `node_id`.
- **One record of blocking**: native dependencies are the only record of what blocks a task. To read a task's blockers, run `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by`.
- **Frontier query**: list the parent's open sub-issues, drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`) or an assignee, and take the lowest number.
- **Claim**: `gh issue edit <n> --add-assignee @me`, as the session's first write.
