# cc-docker-demo v2

Proof-of-concept for CPM v4: Run Claude Code in **two isolation modes** and compare.

## The Two Modes

### Mode A: Plain Docker Container
- Standard `docker run` with custom Dockerfile
- cc installed via `npm install -g @anthropic-ai/claude-code`
- Auth: `CLAUDE_CODE_OAUTH_TOKEN` env var (Max plan)
- Isolation: Container (shared host kernel)
- Works with: Docker Engine, Docker Desktop, **Podman**

### Mode B: Docker Sandbox (microVM)
- Docker Desktop's purpose-built agent sandbox
- Each sandbox runs in a **dedicated microVM** with separate kernel
- Auth: Docker Desktop's host-side proxy (automatic credential injection)
- Network: Built-in allow/deny lists via `docker sandbox network proxy`
- Works with: Docker Desktop 4.58+ (macOS, Windows, experimental Linux)

## Quick Start

```bash
npm install

# Auto-detect available runtimes and run what's possible
npm start

# Or pick a specific mode:
npm run docker      # Mode A only
npm run sandbox     # Mode B only
npm run both        # Run both, compare results
npm run podman      # Mode A with Podman
```

## Prerequisites

### Mode A (Docker/Podman)
- Docker Engine or Podman
- Authenticated Claude Code (`claude` runs without login)
- Claude Max plan

### Mode B (Docker Sandbox)
- Docker Desktop **4.58+** (released Jan 2026)
- Claude Code credentials in shell config (`~/.bashrc` or `~/.zshrc`)
- ⚠️ Env vars must be in shell config, not current session — sandbox daemon reads them at startup

Check your Docker Desktop version:
```bash
docker sandbox version
```

## How Auth Works

### Mode A: OAuth Token Injection
The script reads your token from `~/.claude/.credentials.json` and passes it as `CLAUDE_CODE_OAUTH_TOKEN` env var to the container. The Dockerfile sets `hasCompletedOnboarding: true` in `~/.claude.json` so cc accepts the token.

Token expires in 8-12 hours. For overnight runs, CPM v4 will use a Token Refresh Sidecar.

### Mode B: Docker Desktop Proxy
Docker Desktop runs an HTTP/HTTPS proxy on `host.docker.internal:3128`. When cc makes API calls from inside the sandbox, the proxy automatically injects credentials from your host environment. **No token management needed.**

Credentials never enter the sandbox VM — the proxy intercepts and injects them transparently. When the sandbox is deleted, no credentials remain.

## CPM v4 Mapping

| This demo | CPM v4 |
|-----------|--------|
| `mode-docker.mjs` | `@cpm/runner` container execution strategy |
| `mode-sandbox.mjs` | `@cpm/runner` sandbox execution strategy |
| `Dockerfile` | `cpm-runner:node-22` base image |
| Manual token | Token Refresh Sidecar (Mode A) |
| Auto-detect | Runtime detection in Permission Resolver |
| Single prompt | Ralph Wiggum loop with Task persistence |
| `--both` comparison | CPM recommends best mode per environment |

## Architecture Notes

### Why Two Modes?

**Mode A (Container)** is universal — works everywhere Docker or Podman runs, including CI/CD, Linux servers, and environments without Docker Desktop. But containers share the host kernel, so a kernel exploit could escape.

**Mode B (Sandbox)** provides stronger isolation via microVMs with dedicated kernels. It also handles credentials, network policies, and Docker-in-Docker natively. But it requires Docker Desktop and is currently macOS/Windows only (experimental Linux).

CPM v4 should support both:
- **Local dev (macOS/Windows)**: Prefer Mode B for strongest isolation + auto-auth
- **CI/CD / Linux servers**: Use Mode A with Podman for free licensing
- **Enterprise**: Mode B for security requirements + built-in network policies

### Key Findings to Verify

These are hypotheses we're testing with this demo:

1. **Mode B headless**: Does `docker sandbox run claude -p "prompt"` work for headless execution? Or is sandbox interactive-only?
2. **Mode B exit**: Does sandbox process exit cleanly after `-p` mode completes? Or does the microVM persist?
3. **Mode A token**: Does `CLAUDE_CODE_OAUTH_TOKEN` work reliably with Max plan in fresh containers?
4. **Startup time**: How much overhead does microVM boot add vs container start?
5. **Workspace sync**: Are files created by cc inside sandbox visible immediately on host?
6. **Network**: Can cc run `npm install` in both modes without issues?

Document findings in RESULTS.md after testing!

## File Structure

```
cc-docker-demo/
├── run-demo.mjs          # Unified runner (auto-detect, --mode, --runtime)
├── mode-docker.mjs       # Mode A: Plain Docker/Podman
├── mode-sandbox.mjs      # Mode B: Docker Sandbox microVM
├── lib/
│   └── common.mjs        # Shared: token resolution, workspace, detection
├── extract-token.mjs     # Helper: show OAuth token from cc credentials
├── Dockerfile            # Mode A: Container image with cc installed
├── .env.example          # Mode A: Token config (Mode B doesn't need it)
├── .dockerignore
├── package.json
└── README.md
```

## Troubleshooting

### Mode A: "OAuth token expired"
```bash
# Re-authenticate
claude
# Then retry
npm run docker
```

### Mode B: "Docker Sandbox not available"
```bash
# Check Docker Desktop version (need 4.58+)
docker version
# Upgrade Docker Desktop if needed
```

### Mode B: Auth fails inside sandbox
Docker Sandbox daemon reads env vars from shell config, not current session:
```bash
# Add to ~/.bashrc or ~/.zshrc:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Then restart Docker Desktop
```

### Podman: Image build fails
```bash
# Ensure podman machine is running (macOS)
podman machine start
npm run podman
```
