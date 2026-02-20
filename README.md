# cc-docker-demo v2

Proof-of-concept for CPM v4: Run Claude Code in isolated environments and compare.

## The Three Modes

### Mode A: Plain Docker Container
- Standard `docker run` with custom Dockerfile
- cc installed via `npm install -g @anthropic-ai/claude-code`
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` env var (auto-extracted from macOS Keychain)
- Isolation: Container (shared host kernel)
- Works with: Docker Engine, Docker Desktop, **Podman**

### Mode B: Docker Sandbox (microVM)
- Docker Desktop's purpose-built agent sandbox
- Each run uses a **persistent Firecracker microVM** (`cpm-demo-persistent`) with dedicated kernel
- Auth: credentials injected from macOS Keychain directly into the sandbox before each run
- Network: Built-in allow/deny lists via `docker sandbox network proxy`
- Works with: Docker Desktop 4.58+ (macOS, Windows, experimental Linux)

### Mode C: Fly.io Ephemeral Machine
- Claude Code runs in a **remote Firecracker microVM** on Fly.io
- Machine is auto-deleted after the task completes (`--rm`)
- Auth: OAuth token passed via `--env` to `fly machine run` (sent over HTTPS to Fly API, not in logs)
- **Why Fly.io?** Long autonomous coding tasks that cost significant $ on the API run for free on a Max plan subscription. `CLAUDE_CODE_OAUTH_TOKEN` works identically to Mode A — Fly.io is just a remote host.

## Quick Start

```bash
npm install

# Auto-detect available runtimes and run what's possible
npm start

# Pick a specific mode:
npm run docker      # Mode A: plain Docker container
npm run sandbox     # Mode B: Docker Sandbox microVM
npm run both        # Run both A and B, compare results
npm run podman      # Mode A with Podman
npm run fly         # Mode C: Fly.io ephemeral machine
```

## Prerequisites

### Mode A (Docker/Podman)
- Docker Engine or Podman
- Authenticated Claude Code (`claude` runs without login prompt)
- Claude Max plan

### Mode B (Docker Sandbox)
- Docker Desktop **4.58+** (released Jan 2026)
- Authenticated Claude Code on the host (`claude` runs without login prompt)
- No additional setup — credentials are injected automatically from macOS Keychain

Check your Docker Desktop version:
```bash
docker sandbox version
```

First run creates the persistent sandbox (downloads ~500MB microVM template, takes 2-3 min). Subsequent runs reuse it and are fast.

To reset the sandbox (e.g. after major environment changes):
```bash
docker sandbox rm cpm-demo-persistent
npm run sandbox   # recreates automatically
```

### Mode C (Fly.io)
- [Fly.io account](https://fly.io) + `fly` CLI installed (`brew install flyctl`)
- Claude Max plan (same token as Mode A)
- One-time setup:

```bash
# 1. Edit fly.toml — set your app name (globally unique) and org
# 2. Create the app
fly launch --copy-config --no-deploy

# 3. Build and push image to Fly registry
npm run fly:build

# 4. Run
npm run fly
```

Token is auto-extracted from macOS Keychain on each run — no manual refresh needed.

## How Auth Works

### Mode A & C: OAuth Token
The script auto-extracts your token using a 3-step fallback:

1. **Environment variable** — `CLAUDE_CODE_OAUTH_TOKEN` (from `.env` or `export`)
2. **macOS Keychain** — Claude Code stores credentials under service `"Claude Code-credentials"` as a JSON blob
3. **Legacy file** — `~/.claude/.credentials.json` (older cc versions)

For Mode A, the token is passed as env var to the container. For Mode C, it is passed via `--env` in `fly machine run` — transmitted over HTTPS to the Fly API, not visible in shell history or logs.

The Dockerfile sets `hasCompletedOnboarding: true` in `~/.claude.json` so cc accepts the token without interactive prompts.

Inspect your token:
```bash
node extract-token.mjs              # human-readable summary (updates .env)
node extract-token.mjs --token-only # raw token for scripting
node extract-token.mjs --export     # shell export statement
node extract-token.mjs --json       # full JSON with expiry, plan, scopes
```

### Mode B: Keychain Injection via `docker sandbox exec`

Before each run, `mode-sandbox.mjs` reads the full credentials JSON from the macOS Keychain and pipes it directly into `~/.claude/.credentials.json` inside the persistent sandbox:

```
macOS Keychain
  └─ "Claude Code-credentials" JSON blob
       └─ docker sandbox exec -i cpm-demo-persistent bash -c "cat > ~/.claude/.credentials.json"
            └─ CC reads credentials on startup → authenticated
```

This happens automatically on every `npm run sandbox`. The 29-hour token rotation is handled transparently — the script always reads a fresh token from the Keychain, so as long as you've used `claude` in your terminal recently, auth just works.

**Note on Docker Desktop's "host-side proxy":** The documented auto-injection via Docker Desktop's proxy only works if you sign into Claude through Docker Desktop's own UI. It does not read Claude Code CLI credentials from the Keychain or shell config. The injection approach above is more reliable and portable.

## Mode Comparison

|                  | Mode A              | Mode B                     | Mode C                      |
|------------------|---------------------|----------------------------|-----------------------------|
| Where            | Local Docker/Podman | Local Docker Desktop       | Fly.io (remote)             |
| Isolation        | Container           | Firecracker microVM        | Firecracker microVM         |
| Auth             | `CLAUDE_CODE_OAUTH_TOKEN` | Keychain → exec inject | `--env` to Fly API (HTTPS) |
| Workspace        | Volume mount (`-v`) | Synced path (same absolute) | Remote (files stay on VM)  |
| State            | Ephemeral           | Persistent sandbox         | Ephemeral (`--rm`)          |
| Cost             | Free                | Free                       | Fly.io machine time (~free) |
| Platform         | Anywhere            | macOS / Windows            | Any (remote)                |
| Typical duration | ~30s                | ~35s warm / ~3min first    | ~35s                        |

> **Mode C workspace note:** Files created by cc live inside the Fly machine. Use `--rm` for stateless tasks, or drop it and use `fly machine exec` / `fly ssh` to retrieve files. For CPM v4, have cc commit results to git as part of the task prompt.

## Architecture Notes

### Why multiple modes?

**Mode A** is universal — works anywhere Docker or Podman runs, including CI/CD and Linux servers. But containers share the host kernel.

**Mode B** gives stronger isolation (microVM) plus automatic credential rotation. Requires Docker Desktop (macOS/Windows only). Persistent sandbox avoids repeated microVM boot time after the first run.

**Mode C** moves execution off your machine entirely. Useful when you want to run long tasks without keeping a laptop open, or when you need a clean Linux environment. Max plan credentials work identically to Mode A — the Fly microVM just happens to be remote.

### Token lifetime and overnight runs

OAuth tokens expire after ~29 hours. This is sufficient for typical autonomous overnight runs (start at 11pm, done by morning). For longer multi-day tasks, the script includes a pre-flight expiry check. As a fallback, Mode A and C can fall back to `ANTHROPIC_API_KEY` if available and the OAuth token has expired.

### Log streaming (Mode C)
`fly machine run` returns as soon as the machine **starts** (not when it exits). Container stdout/stderr goes to Fly's logging infrastructure. `mode-fly.mjs` runs `fly logs` concurrently and watches for the machine exit signal to know when the task is done.

### Why is the app "Suspended" in the Fly dashboard?
Expected behavior. The app uses `--rm` ephemeral machines — every machine is deleted when cc exits. With 0 running machines, Fly shows the app as "Suspended" (grey). During a run, a machine briefly appears. This is a batch runner, not a web service.

## File Structure

```
cc-docker-demo/
├── run-demo.mjs          # Unified runner (auto-detect, --mode, --runtime)
├── mode-docker.mjs       # Mode A: Plain Docker/Podman
├── mode-sandbox.mjs      # Mode B: Docker Sandbox microVM (persistent)
├── mode-fly.mjs          # Mode C: Fly.io ephemeral machine
├── lib/
│   └── common.mjs        # Shared: token resolution, workspace, TEST_PROMPT, detection
├── extract-token.mjs     # Show/extract OAuth token from cc credentials
├── Dockerfile            # cc image (linux/amd64, node:22-slim)
├── fly.toml              # Fly.io app config (no [[services]] — batch runner only)
├── .env.example          # Token + Fly.io config template
├── .gitignore
├── package.json
└── README.md
```

## Troubleshooting

### "OAuth token expired"
```bash
# Refresh by using Claude Code in your terminal
claude
# Or re-extract and update .env:
node extract-token.mjs
```

### Mode A: "No OAuth token found"
```bash
node extract-token.mjs   # shows where tokens are and their status
```

### Mode B: "Not logged in"
The sandbox couldn't get credentials. Check:
```bash
# Verify you have a valid token on the host
node extract-token.mjs

# Verify credentials were injected into sandbox
docker sandbox exec -it cpm-demo-persistent bash -c "ls -la ~/.claude/"

# If the sandbox is corrupted, reset it:
docker sandbox rm cpm-demo-persistent
npm run sandbox   # recreates and re-injects credentials
```

### Mode B: "Docker Sandbox not available"
```bash
docker sandbox version   # must be v0.12+
# Upgrade Docker Desktop to 4.58+ if missing
```

### Mode C: "No image ref found"
```bash
npm run fly:build   # build + push image (only needed after Dockerfile changes)
```

### Mode C: fly logs shows old runs
Normal — `fly logs` streams all recent app logs. Old lines appear at startup and scroll away. Output is filtered to the current machine ID automatically.

### Podman: Image build fails
```bash
podman machine start   # ensure podman VM is running (macOS)
npm run podman
```
