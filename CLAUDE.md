# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Proof-of-concept for running Claude Code (cc) in two container isolation modes:

- **Mode A (Docker/Podman)**: Plain container with shared host kernel. Auth via `CLAUDE_CODE_OAUTH_TOKEN` env var. Works anywhere Docker or Podman runs.
- **Mode B (Docker Sandbox)**: microVM with dedicated kernel via Docker Desktop 4.58+. Auth via Docker Desktop's host-side proxy (no token management needed).

The goal is to compare both modes for use in CPM v4 (an autonomous task runner).

## Commands

```bash
npm install          # Install dotenv dependency

npm start            # Auto-detect available runtimes and run
npm run docker       # Mode A: plain Docker container
npm run sandbox      # Mode B: Docker Sandbox microVM
npm run both         # Run both modes and print comparison table
npm run podman       # Mode A with Podman instead of Docker
npm run fly          # Mode C: Fly.io ephemeral machine
npm run fly:build    # Build + push image to fly's registry (run after Dockerfile changes)
npm run fly:push-token  # Re-push OAuth token to fly secrets (~29h expiry)

npm run build        # Build Docker image locally (cpm-runner:demo)
npm run token:show   # Inspect your OAuth token (expiry, plan, scopes)
npm run sandbox:list # List all active Docker Sandboxes (microVMs, not in docker ps)
```

Fly.io one-time setup:
```bash
fly launch --copy-config --no-deploy   # create app (update name in fly.toml first)
fly auth docker                        # authenticate docker to fly's registry
npm run fly:build                      # build + push image
npm run fly                            # run first task
```

Docker Sandbox debugging:
```bash
docker sandbox exec -it <sandbox-name> bash   # shell inside a running sandbox
docker sandbox rm <name> [name2 ...]          # delete sandbox(es) + installed packages
docker sandbox run <name>                     # reconnect to an existing sandbox
```

Individual mode scripts can also run standalone:
```bash
node mode-docker.mjs [podman]
node mode-sandbox.mjs
node extract-token.mjs [--token-only | --export | --json]
```

## Architecture

### Entry point: `run-demo.mjs`
Parses `--mode` and `--runtime` args, calls `detectRuntimes()`, then dispatches to `runModeDocker()` and/or `runModeSandbox()`. Prints a comparison table when both modes run.

### `lib/common.mjs` — shared utilities
- `resolveToken()`: 3-step fallback for OAuth token (env var → macOS Keychain service `"Claude Code-credentials"` → `~/.claude/.credentials.json`)
- `createWorkspace()`: creates a temp dir (`/tmp/cc-docker-demo-*`) with a minimal `package.json`
- `detectRuntimes()`: checks availability of `docker`, `docker sandbox`, and `podman`
- `TEST_PROMPT`: the fixed prompt cc executes inside the container (creates and runs `hello.mjs`)

### `mode-docker.mjs`
Builds image `cpm-runner:demo` if missing, resolves token, spawns `docker run --rm -v <workspace>:/workspace -e CLAUDE_CODE_OAUTH_TOKEN=<token> cpm-runner:demo`. cc runs as non-root `agent` user with `--dangerously-skip-permissions`.

### `mode-sandbox.mjs`
Spawns `docker sandbox run --name <sandbox> --workspace <dir> claude -p --dangerously-skip-permissions`. Docker Desktop's proxy handles credentials. Cleans up sandbox with `docker sandbox rm` after run.

### `Dockerfile`
Builds `node:22-slim` image with cc installed globally. Pre-sets `hasCompletedOnboarding: true` in `/home/agent/.claude.json` (required for headless OAuth token acceptance). Entrypoint is `claude -p --dangerously-skip-permissions`.

## Execution Modes

| | Mode A | Mode B | Mode C | Mode D |
|---|---|---|---|---|
| Where | Local Docker/Podman | Local Docker Desktop | Fly.io (remote) | Local Incus via `koi` |
| Isolation | Container (shared kernel) | microVM (dedicated kernel) | Container (Fly.io managed) | System container (full Linux) |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` | Host-side proxy (auto) | fly secrets (encrypted) | `CLAUDE_CODE_OAUTH_TOKEN` |
| Token mgmt | Extract from Keychain | Automatic | `fly:push-token` (~29h) | Extract from Keychain |
| Workspace sync | Volume mount (`-v`) | Same path | Files stay remote* | UID-mapped (your user) |
| State | Ephemeral | Persists | Ephemeral (`--rm`) | Persistent |
| Cost | Free | Free | Fly.io machine time | Free |
| macOS | Yes | Yes | Yes (remote) | K Lima → Incus nesting |

*For Mode C workspace: either have cc commit results to git in the prompt, or drop `--rm` and use `fly machine exec` / `fly ssh` to retrieve files.

**Why Fly.io (Mode C)?** Running cc on Fly.io with Max plan credentials avoids per-token API costs entirely. Long autonomous coding tasks that would cost significant $ on the API run for free on a Max subscription. The `CLAUDE_CODE_OAUTH_TOKEN` approach works identically to Mode A — Fly.io is just a remote Docker host.

**Note:** Claude Code also has a *native* sandbox (`/sandbox` slash command) that uses OS-level primitives (Seatbelt on macOS, bubblewrap on Linux) to isolate bash commands by filesystem path and network domain — this is separate from all three container modes above. The `@anthropic-ai/sandbox-runtime` npm package exposes this programmatically.

## Auth Notes

- **Mode A**: Token auto-extracted from macOS Keychain (service `"Claude Code-credentials"`, JSON blob with `claudeAiOauth.accessToken`). Expires in ~29 hours. Manual override: set `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (copy from `.env.example`).
- **Mode B**: Docker Desktop daemon reads credentials from shell config (`~/.bashrc` / `~/.zshrc`) at startup — not from current session. If auth fails, add token to shell config and restart Docker Desktop.

## Docker Sandbox Gotchas

- Sandboxes **don't appear in `docker ps`** — they're microVMs, not containers. Use `docker sandbox ls`.
- Sandboxes **persist after disconnection** — failed/abandoned runs leave orphaned sandboxes. `mode-sandbox.mjs` warns about these on startup.
- Sandbox config is **immutable** — env vars, volumes, and options cannot be changed after creation. Must delete and recreate. That's why each run uses a timestamp-based name.
- Missing binaries (`make`, etc.) aren't pre-installed — must be installed inside the sandbox or baked into a custom template.
- Env vars must be in shell config (`~/.bashrc`, `~/.zshrc`) not the current session — the Docker Desktop daemon reads them at startup.

## Key Hypothesis Being Tested

RESULTS.md contains a checklist of open questions: whether `-p` headless works in Docker Sandbox, whether the host proxy handles Max plan auth automatically, microVM startup overhead vs container, and workspace file sync behavior. Document findings there after testing.
