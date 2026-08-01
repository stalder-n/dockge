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

## Cursor Cloud specific instructions

The startup update script runs `npm install` (via nvm's Node). Everything below is NOT
handled automatically and must be done each session before running the app. Standard
commands live in `package.json`; only the non-obvious caveats are captured here.

### Node version gotcha (important)

`/exec-daemon/node` is a v22.14.0 binary that sits early on `PATH` and **shadows** nvm's
Node in plain/non-login shells, even after `nvm use`. The repo requires Node `>= 22.18.0`.
- Interactive login shells are fine: `~/.bashrc` was patched to force nvm's default Node
  (v22.22.2) to the front of `PATH`, so `bash -lc '<cmd>'` gets the correct Node.
- In a non-login shell, prepend nvm's bin yourself:
  `export PATH="$(dirname "$(nvm which default)"):$PATH"` (after sourcing `~/.nvm/nvm.sh`).

### Docker is required and is NOT auto-started

Dockge shells out to `docker compose`, so a running Docker daemon is mandatory. Docker
Engine + Compose v2 are pre-installed in the VM image, but `systemd` is not running, so
start the daemon manually once per session:
- Start it in the background (e.g. a tmux session): `sudo dockerd` (logs are useful to tee to a file).
- Config already set in `/etc/docker/daemon.json`: `storage-driver: fuse-overlayfs` and
  `features.containerd-snapshotter: false` (required for Docker 29 + fuse-overlayfs in this VM).
- The run user is not in a working `docker` group here (supplementary groups don't refresh
  in spawned shells), so after `dockerd` starts, make the socket usable:
  `sudo chmod 666 /var/run/docker.sock`. Then `docker ps` works without `sudo`.

### Stacks directory

Dockge writes each stack's `compose.yaml` under `DOCKGE_STACKS_DIR` (default `/opt/stacks`).
Ensure it exists and is owned by the run user: `sudo mkdir -p /opt/stacks && sudo chown -R "$USER" /opt/stacks`.

### Running the app (dev)

`npm run dev` starts Vite frontend on `:5000` and the backend/Socket.IO server on `:5001`
(see `package.json`). Open the **frontend** at `http://localhost:5000`. On a fresh DB
(`data/dockge.db`, auto-created) the first page is a one-time "Create your admin account"
setup. There is no unit test suite; quality gates are `npm run lint` and `npm run check-ts`
(also the CI in `.github/workflows/ci.yml`, plus `npm run build:frontend`).
