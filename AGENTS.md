# AGENTS.md

Fixed instructions for coding agents working in this repository.

## Forgejo: always use `fjo`

This repo’s `origin` is Forgejo at `git.ivonic.ch` (`stalder-n/dockge`), **not** GitHub.

**Always use the `fjo` CLI** for Forgejo/Gitea work: pull requests, issues, reviews, labels, milestones, Actions runs, and the Contents API.

| Do | Don’t |
|---|---|
| `fjo pr create` / `view` / `list` / `comment` / … | `gh` against this remote |
| `fjo issue …`, `fjo run …`, etc. | Raw `curl` to `/api/v1/...` when `fjo` covers it |
| `fjo --agent-help` or `fjo <cmd> --help` when unsure | `tea` / `glab` workflows for this host |
| `--json` when parsing CLI output | Print `FORGEJO_TOKEN` / `--token` values |

Auth: `FORGEJO_TOKEN` or `fjo --token`.

```bash
fjo pr create --base master --head cursor/my-branch --title "…" --body "$(cat <<'EOF'
## Summary
- …

## Test plan
- [ ] …
EOF
)"

fjo pr view 1
fjo pr list --json
```

Also mirrored in [`.cursor/rules/use-fjo-cli.mdc`](.cursor/rules/use-fjo-cli.mdc).
