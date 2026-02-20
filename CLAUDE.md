# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Proof-of-concept for running Claude Code (cc) in isolated environments. Three working modes:

- **Mode A (Docker/Podman)**: Plain container, shared host kernel. Auth via `CLAUDE_CODE_OAUTH_TOKEN`. Works anywhere Docker/Podman runs.
- **Mode B (Docker Sandbox)**: Firecracker microVM via Docker Desktop 4.58+. Auth via Docker Desktop host-side proxy (automatic).
- **Mode C (Fly.io)**: Remote Firecracker microVM on Fly.io. Ephemeral (`--rm`). Auth via `--env` flag in `fly machine run` (HTTPS to Fly API). Enables running long tasks with Max plan credentials at no per-token cost.

## Commands

```bash
npm install          # Install dotenv dependency

npm start            # Auto-detect runtimes and run
npm run docker       # Mode A: plain Docker container
npm run sandbox      # Mode B: Docker Sandbox microVM
npm run both         # Run both A and B, print comparison
npm run podman       # Mode A with Podman
npm run fly          # Mode C: Fly.io ephemeral machine
npm run fly:build    # Build linux/amd64 image and push to fly registry

npm run build        # Build Docker image locally (cpm-runner:demo)
npm run token:show   # Inspect OAuth token (expiry, plan, scopes)
npm run sandbox:list # List active Docker Sandboxes (not in docker ps)
```

Mode C one-time setup:
```bash
# Edit fly.toml: set app name (globally unique) and org slug
fly launch --copy-config --no-deploy   # create app on fly.io
npm run fly:build                      # build linux/amd64 + push to registry
npm run fly                            # run first task
```

Token refresh (Mode C token auto-extracted from Keychain on each run):
```bash
node extract-token.mjs   # updates .env with fresh token from macOS Keychain
```

Docker Sandbox debugging:
```bash
docker sandbox exec -it <sandbox-name> bash   # shell inside running sandbox
docker sandbox rm <name>                      # delete sandbox + packages
docker sandbox run <name>                     # reconnect to existing sandbox
```

Standalone mode scripts:
```bash
node mode-docker.mjs [podman]
node mode-sandbox.mjs
node mode-fly.mjs [--build-only]
node extract-token.mjs [--token-only | --export | --json]
```

## Architecture

### Entry point: `run-demo.mjs`
Parses `--mode` and `--runtime` args, calls `detectRuntimes()`, dispatches to mode functions. Prints a comparison table when both A and B run.

### `lib/common.mjs` — shared utilities
- `resolveToken()`: 3-step fallback — env var → macOS Keychain service `"Claude Code-credentials"` → `~/.claude/.credentials.json`
- `createWorkspace()`: creates temp dir `/tmp/cc-docker-demo-*` with minimal `package.json`
- `detectRuntimes()`: checks availability of `docker`, `docker sandbox`, `podman`, `fly`, `koi`
- `TEST_PROMPT`: fixed prompt cc executes inside all modes (creates and runs `hello.mjs`)

### `mode-docker.mjs`
Builds `cpm-runner:demo` if missing, resolves token, spawns `docker run --rm -v <workspace>:/workspace -e CLAUDE_CODE_OAUTH_TOKEN=<token> cpm-runner:demo`.

### `mode-sandbox.mjs`
Warns about orphaned sandboxes on startup. Spawns `docker sandbox run --name <sandbox> --workspace <dir> claude -p --dangerously-skip-permissions`. Cleans up with `docker sandbox rm` after run.

### `mode-fly.mjs`
Three functions:
- `buildFlyImage(appName)`: `docker build --platform linux/amd64` + `fly auth docker` + `docker push` to `registry.fly.io/<app>:demo`. Saves ref to `.fly-image-ref`.
- `runModeFly(options)`: resolves token, starts `fly logs` stream, launches `fly machine run <image> --env CLAUDE_CODE_OAUTH_TOKEN=<token> --rm`, watches log stream for machine exit signal, stops when `machine restart policy set to 'no'` is detected for the current machine ID.
- Machine ID is parsed from `fly machine run` stdout (`Machine ID: <id>`), used to filter exit detection in the log stream.

### `Dockerfile`
`node:22-slim`, cc installed globally, non-root `agent` user, `hasCompletedOnboarding: true` pre-set. Entrypoint: `claude -p --dangerously-skip-permissions`. Build target: `linux/amd64` (Fly.io runs amd64).

### `fly.toml`
App config for `cpm-claude-code-demo` in webhouse org, region `arn` (Stockholm). No `[[services]]` — batch runner only, no web endpoints.

## Execution Mode Comparison

| | Mode A | Mode B | Mode C |
|---|---|---|---|
| Where | Local Docker/Podman | Local Docker Desktop | Fly.io (remote) |
| Isolation | Container (shared kernel) | Firecracker microVM | Firecracker microVM |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` env | Host-side proxy (auto) | `--env` via HTTPS to Fly API |
| Token mgmt | Auto from Keychain | Automatic | Auto from Keychain |
| Workspace | Volume mount (`-v`) | Same path | Files stay remote |
| State | Ephemeral | Persists | Ephemeral (`--rm`) |
| Platform | Anywhere | macOS / Windows | Any (remote) |

**Mode C workspace:** Files live inside the Fly microVM. For persistent results, include `git commit && git push` in the task prompt, or drop `--rm` and use `fly ssh` to retrieve files.

**Native sandbox note:** Claude Code also has a `/sandbox` slash command using OS-level primitives (Seatbelt/macOS, bubblewrap/Linux). Separate from all container modes. Exposed programmatically via `@anthropic-ai/sandbox-runtime`.

## Auth Notes

- **Mode A/C**: `resolveToken()` checks: `CLAUDE_CODE_OAUTH_TOKEN` env → macOS Keychain → `~/.claude/.credentials.json`. Token expires ~29h. `node extract-token.mjs` refreshes `.env` from Keychain.
- **Mode B**: Docker Desktop daemon reads env vars from shell config (`~/.bashrc`/`~/.zshrc`) at startup, not current session. Auth failure → add token to shell config → restart Docker Desktop.
- **Mode C**: `fly secrets` cannot be used for apps with no persistent machines (secrets get staged but never deployed). Token is passed directly via `--env` in `fly machine run`.

## Docker Sandbox Gotchas

- Sandboxes **don't appear in `docker ps`** — they're microVMs. Use `docker sandbox ls`.
- Sandboxes **persist after disconnection** — failed runs leave orphaned sandboxes. `mode-sandbox.mjs` warns about `cpm-demo-*` orphans on startup.
- Sandbox config is **immutable** — cannot change env vars or volumes after creation. Each run uses a timestamp-based name.
- Env vars must be in shell config (`~/.bashrc`/`~/.zshrc`), not the current session.

## Fly.io Notes

- `fly machine run --rm` returns when the machine **starts**, not when it exits. Container output goes to Fly's logging system, not to the calling process's stdio.
- Log streaming: `fly logs` is started before machine launch and kept alive until the exit signal appears in the stream. This correctly captures the full CC output.
- "Suspended" status in Fly dashboard is expected — no persistent machines, app shows 0/0 machines when idle.
- `fly deploy --local-only --build-only` builds but **does not push** to the registry (only names the image locally). Use `docker build + docker push` instead.
- Fly.io registry (`registry.fly.io/<app>`) is initialized on first push, not on `fly apps create`.
