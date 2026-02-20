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
- Each sandbox runs in a **dedicated Firecracker microVM** with separate kernel
- Auth: Docker Desktop's host-side proxy (automatic credential injection)
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
- Claude Code credentials in shell config (`~/.bashrc` or `~/.zshrc`)
- ⚠️ Env vars must be in shell config, not current session — sandbox daemon reads them at startup

Check your Docker Desktop version:
```bash
docker sandbox version
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

When the token expires (~29h), refresh it:
```bash
node extract-token.mjs   # updates .env automatically
npm run fly              # picks up fresh token on next run
```

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

### Mode B: Docker Desktop Proxy
Docker Desktop runs an HTTP/HTTPS proxy on `host.docker.internal:3128`. When cc makes API calls from inside the sandbox, the proxy automatically injects credentials from your host environment. **No token management needed.**

Credentials never enter the sandbox VM — the proxy intercepts and injects them transparently.

## Mode Comparison

|                  | Mode A              | Mode B                     | Mode C                      |
|------------------|---------------------|----------------------------|-----------------------------|
| Where            | Local Docker/Podman | Local Docker Desktop       | Fly.io (remote)             |
| Isolation        | Container           | Firecracker microVM        | Firecracker microVM         |
| Auth             | `CLAUDE_CODE_OAUTH_TOKEN` | Host-side proxy (auto) | `--env` to Fly API (HTTPS) |
| Workspace        | Volume mount (`-v`) | Same path                  | Remote (files stay on VM)   |
| State            | Ephemeral           | Persists                   | Ephemeral (`--rm`)          |
| Cost             | Free                | Free                       | Fly.io machine time (~free) |
| Platform         | Anywhere            | macOS / Windows            | Any (remote)                |

> **Mode C workspace note:** Files created by cc live inside the Fly machine. Use `--rm` for stateless tasks, or drop it and use `fly machine exec` / `fly ssh` to retrieve files. For CPM v4, have cc commit results to git as part of the task prompt.

## Architecture Notes

### Why multiple modes?

**Mode A** is universal — works anywhere Docker or Podman runs, including CI/CD and Linux servers. But containers share the host kernel.

**Mode B** gives stronger isolation (microVM) plus auto-credential injection and built-in network policies. Requires Docker Desktop (macOS/Windows only).

**Mode C** moves execution off your machine entirely. Useful when you want to run long tasks without keeping a laptop open, or when you need a clean Linux environment. Max plan credentials work identically to Mode A — the Fly microVM just happens to be in Stockholm.

### Log streaming (Mode C)
`fly machine run` returns as soon as the machine **starts** (not when it exits). Container stdout/stderr goes to Fly's logging infrastructure. `mode-fly.mjs` runs `fly logs` concurrently and watches for the machine exit signal to know when the task is done.

### Why is the app "Suspended" in the Fly dashboard?
Expected behavior. The app uses `--rm` ephemeral machines — every machine is deleted when cc exits. With 0 running machines, Fly shows the app as "Suspended" (grey). During a run, a machine briefly appears. This is a batch runner, not a web service.

## File Structure

```
cc-docker-demo/
├── run-demo.mjs          # Unified runner (auto-detect, --mode, --runtime)
├── mode-docker.mjs       # Mode A: Plain Docker/Podman
├── mode-sandbox.mjs      # Mode B: Docker Sandbox microVM
├── mode-fly.mjs          # Mode C: Fly.io ephemeral machine
├── lib/
│   └── common.mjs        # Shared: token resolution, TEST_PROMPT, detection
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
# Refresh by opening Claude Code in your terminal
claude
# Or re-extract and update .env:
node extract-token.mjs
npm run fly   # or npm run docker
```

### Mode A: "No OAuth token found"
```bash
# Check what tokens are available
node extract-token.mjs

# Or manually extract from macOS Keychain
security find-generic-password -s "Claude Code-credentials" -w | node -e "
  const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.claudeAiOauth.accessToken.slice(0,20)+'...')
"
```

### Mode B: "Docker Sandbox not available"
```bash
# Check Docker Desktop version (need 4.58+)
docker version
```

### Mode B: Auth fails inside sandbox
Docker Sandbox daemon reads env vars from shell config, not current session:
```bash
# Add to ~/.bashrc or ~/.zshrc:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
# Then restart Docker Desktop
```

### Mode C: "No image ref found"
```bash
npm run fly:build   # build + push image (only needed after Dockerfile changes)
```

### Mode C: fly logs shows old runs
This is normal — `fly logs` streams all recent app logs, not just the current run. The output section is filtered to the current machine ID automatically. Old log lines appear at startup and scroll away once the new machine starts.

### Podman: Image build fails
```bash
# Ensure podman machine is running (macOS)
podman machine start
npm run podman
```
