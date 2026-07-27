# AGENTS.md

Fixed instructions for coding agents working in this repository.

## GitHub: always use `gh`

This repo’s `origin` is GitHub at `github.com/stalder-n/dockge` (fork of [louislam/dockge](https://github.com/louislam/dockge)).

**Always use the `gh` CLI** for GitHub work: pull requests, issues, reviews, labels, milestones, Actions runs, and the Contents API.

| Do | Don’t |
|---|---|
| `gh pr create` / `view` / `list` / `comment` / … | Raw `curl` to the API when `gh` covers it |
| `gh issue …`, `gh run …`, etc. | Print `GH_TOKEN` / `GITHUB_TOKEN` values |
| `gh help` or `gh <cmd> --help` when unsure | |
| `--json` when parsing CLI output | |

Auth: `GH_TOKEN` / `GITHUB_TOKEN`, or `gh auth login`.

```bash
gh pr create --base master --head cursor/my-branch --title "…" --body "$(cat <<'EOF'
## Summary
- …

## Test plan
- [ ] …
EOF
)"

gh pr view 1
gh pr list --json number,title,url
```

Also mirrored briefly in [`.cursor/rules/use-gh-cli.mdc`](.cursor/rules/use-gh-cli.mdc).
