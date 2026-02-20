# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Proof-of-concept for running Claude Code (cc) in isolated environments. Three working modes:

- **Mode A (Docker/Podman)**: Plain container, shared host kernel. Auth via `CLAUDE_CODE_OAUTH_TOKEN`. Works anywhere Docker/Podman runs.
- **Mode B (Docker Sandbox)**: Firecracker microVM via Docker Desktop 4.58+. Auth via Keychain credential injection into a persistent sandbox.
- **Mode C (Fly.io)**: Remote Firecracker microVM on Fly.io. Ephemeral (`--rm`). Auth via `--env` flag in `fly machine run` (HTTPS to Fly API). Enables running long tasks with Max plan credentials at no per-token cost.

## Commands

```bash
npm install          # Install dotenv dependency

npm start            # Auto-detect runtimes and run
npm run docker       # Mode A: plain Docker container
npm run sandbox      # Mode B: Docker Sandbox microVM (persistent sandbox)
npm run both         # Run both A and B, print comparison
npm run podman       # Mode A with Podman
npm run fly          # Mode C: Fly.io ephemeral machine
npm run fly:build    # Build linux/amd64 image and push to Fly registry

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

Token refresh (auto-extracted from Keychain on each run for Mode A/B/C):
```bash
node extract-token.mjs   # updates .env with fresh token from macOS Keychain
```

Docker Sandbox debugging:
```bash
docker sandbox exec -it cpm-demo-persistent bash   # shell inside persistent sandbox
docker sandbox rm cpm-demo-persistent              # delete sandbox (forces recreation + re-login)
docker sandbox ls                                  # list all sandboxes
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
- `createWorkspace()`: creates temp dir under `realpathSync('/tmp')` on macOS (resolves to `/private/tmp`) — NOT `os.tmpdir()` which returns `/var/folders/...` that Docker Sandbox cannot sync
- `detectRuntimes()`: checks availability of `docker`, `docker sandbox`, `podman`, `fly`, `koi`
- `TEST_PROMPT`: fixed prompt cc executes inside all modes (creates and runs `hello.mjs`)

### `mode-docker.mjs`
Builds `cpm-runner:demo` if missing, resolves token, spawns `docker run --rm -v <workspace>:/workspace -e CLAUDE_CODE_OAUTH_TOKEN=<token> cpm-runner:demo`.

### `mode-sandbox.mjs`
Uses a **persistent sandbox** (`cpm-demo-persistent`) with a fixed workspace at `/private/tmp/cpm-sandbox-workspace`.

Startup sequence on each run:
1. Check if `cpm-demo-persistent` exists (`docker sandbox ls`)
2. If not: create it by running `docker sandbox run --name cpm-demo-persistent claude <workspace> -- --version` (creates sandbox, `--version` needs no auth and exits immediately)
3. Inject credentials from macOS Keychain via `docker sandbox exec -i` piping full JSON to `~/.claude/.credentials.json` inside the microVM
4. Write `~/.claude.json` with `hasCompletedOnboarding: true` via same mechanism
5. Run task: `docker sandbox run cpm-demo-persistent -- -p --dangerously-skip-permissions ...`
6. Sandbox is kept alive for subsequent runs

This approach handles 29h token rotation automatically — fresh credentials are injected from the Keychain before every run, no shell config or Docker Desktop restart needed.

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
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` env | Keychain → exec injection | `--env` via HTTPS to Fly API |
| Token mgmt | Auto from Keychain | Auto from Keychain per run | Auto from Keychain |
| Workspace | Volume mount (`-v`) | Synced path (same absolute) | Files stay remote |
| State | Ephemeral | Persistent sandbox | Ephemeral (`--rm`) |
| Platform | Anywhere | macOS / Windows | Any (remote) |
| Typical duration | ~30s | ~35s (warm) / ~3min (cold) | ~35s |

**Mode C workspace:** Files live inside the Fly microVM. For persistent results, include `git commit && git push` in the task prompt, or drop `--rm` and use `fly ssh` to retrieve files.

**Native sandbox note:** Claude Code also has a `/sandbox` slash command using OS-level primitives (Seatbelt/macOS, bubblewrap/Linux). Separate from all container modes.

## Auth Notes

- **Mode A/C**: `resolveToken()` checks: `CLAUDE_CODE_OAUTH_TOKEN` env → macOS Keychain → `~/.claude/.credentials.json`. Token expires ~29h. `node extract-token.mjs` refreshes `.env` from Keychain. For autonomous overnight runs: 29h window is sufficient if token is fresh at task start.
- **Mode B**: Does NOT use Docker Desktop's host-side proxy for auth (that only works with Docker Desktop's own Claude account, not Claude Code CLI credentials). Instead, `mode-sandbox.mjs` reads the full credentials JSON from macOS Keychain and pipes it into `~/.claude/.credentials.json` inside the persistent sandbox via `docker sandbox exec -i` before each run.
- **Mode C**: `fly secrets` cannot be used for apps with no persistent machines (secrets get staged but never deployed). Token is passed directly via `--env` in `fly machine run`.

## Docker Sandbox Gotchas (discovered through testing)

- Sandboxes **don't appear in `docker ps`** — they're microVMs. Use `docker sandbox ls`.
- `docker sandbox exec` **without `-i` does not forward stdin** — writing files via `cat > file` with `{ input: ... }` in spawnSync silently produces a 0-byte file. Always use `-i`.
- **`os.tmpdir()` on macOS returns `/var/folders/...`** — Docker Sandbox cannot sync this path (not in Docker Desktop's file sharing config). Use `realpathSync('/tmp')` to get `/private/tmp` instead.
- **Docker Sandbox v0.12 syntax change**: `--workspace <path>` was removed. Workspace is now a positional argument: `docker sandbox run <agent> <workspace> -- <agent-args>`.
- Docker Desktop's **"host-side proxy"** for credentials only works if you sign into Claude through Docker Desktop's own UI (not via Claude Code CLI). Shell config env vars (`~/.bashrc`, `~/.zshrc`) are unreliably picked up — do not depend on this mechanism.
- Sandbox config is **immutable after creation** — cannot add workspaces or change env vars. To reconfigure, `docker sandbox rm <name>` and recreate.

## Fly.io Notes

- `fly machine run --rm` returns when the machine **starts**, not when it exits. Container output goes to Fly's logging system, not to the calling process's stdio.
- Log streaming: `fly logs` is started before machine launch and kept alive until the exit signal appears in the stream. This correctly captures the full CC output.
- Machine ID is in `fly machine run` **stdout** (not stderr). Pattern: `Machine ID: <id>`.
- "Suspended" status in Fly dashboard is expected — no persistent machines, app shows 0/0 machines when idle.
- `fly deploy --local-only --build-only` builds but **does not push** to the registry (only names the image locally). Use `docker build + docker push` instead.
- Mac builds produce ARM64 images. Fly.io requires AMD64. Always use `--platform linux/amd64` in `docker build`.
- Fly.io registry (`registry.fly.io/<app>`) is initialized on first push, not on `fly apps create`.
