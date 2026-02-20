// lib/common.mjs
// Shared utilities for both Docker and Docker Sandbox modes

import { readFileSync, mkdtempSync, writeFileSync, realpathSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// ─────────────────────────────────────────────────────
// Test prompt — cc will execute this inside the container
// ─────────────────────────────────────────────────────

export const TEST_PROMPT = `
Create a single file called hello.mjs that:
1. Prints "Hello from Claude Code! 🐳"
2. Prints the current date, Node.js version, and hostname
3. Lists the files in the current directory
4. Prints whether it detects Docker or Docker Sandbox environment

Then run it with: node hello.mjs

Show me the output.
`.trim();

// ─────────────────────────────────────────────────────
// Token Resolution (for plain Docker mode)
// Checks in order:
//   1. CLAUDE_CODE_OAUTH_TOKEN env var / .env
//   2. macOS Keychain ("Claude Code-credentials")
//   3. Legacy ~/.claude/.credentials.json (older cc versions)
// ─────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const AUTO_RENEW_THRESHOLD_HOURS = 2;

function checkExpiry(expiresAt, source) {
  const hoursLeft = ((expiresAt - Date.now()) / 3600000).toFixed(1);
  if (hoursLeft <= 0) {
    console.error(`❌ OAuth token expired (from ${source}). Run "claude" to refresh.`);
    process.exit(1);
  }
  return hoursLeft;
}

// Read current token expiry from Keychain (macOS) or .credentials.json (Linux/fallback)
function getTokenExpiry() {
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
      if (expiresAt) return expiresAt;
    } catch { /* fall through */ }
  }
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf-8');
    const expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
    if (expiresAt) return expiresAt;
  } catch { /* fall through */ }
  return null;
}

// Auto-renew by running `claude -p "hi"` — CC refreshes OAuth token before the API call
// and persists the new token to Keychain (macOS) or .credentials.json (Linux).
// Skipped when using CLAUDE_CODE_OAUTH_TOKEN env var (externally managed token).
function autoRenewIfNeeded() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return;

  const expiresAt = getTokenExpiry();
  if (!expiresAt) return;

  const hoursLeft = (expiresAt - Date.now()) / 3600000;
  if (hoursLeft > AUTO_RENEW_THRESHOLD_HOURS) return;

  const status = hoursLeft <= 0 ? 'expired' : `${hoursLeft.toFixed(1)}h remaining`;
  console.log(`🔄 Token ${status} — auto-renewing via claude...`);

  try {
    execSync('claude -p "hi" --output-format text --max-turns 1', {
      timeout: 30000,
      stdio: 'pipe',
    });
    console.log('✅ Token renewed');
  } catch {
    if (hoursLeft <= 0) {
      console.error('❌ Auto-renewal failed and token is expired. Run "claude" manually.');
      process.exit(1);
    }
    console.warn(`⚠️  Auto-renewal failed — ${hoursLeft.toFixed(1)}h remaining, proceeding`);
  }
}

export function resolveToken() {
  // Auto-renew if expired or expiring within threshold (skipped for env var tokens)
  autoRenewIfNeeded();
  // Priority 1: Environment variable (from .env or export)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('🔑 Token source: environment variable');
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // Priority 2: macOS Keychain (Claude Code 2025+)
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      const creds = JSON.parse(raw);
      const oauth = creds?.claudeAiOauth;

      if (oauth?.accessToken) {
        const hoursLeft = checkExpiry(oauth.expiresAt, 'Keychain');
        console.log(`🔑 Token source: macOS Keychain (${hoursLeft}h remaining, ${oauth.subscriptionType})`);
        return oauth.accessToken;
      }
    } catch {
      // Keychain entry not found or not parseable — fall through
    }
  }

  // Priority 3: Legacy credentials file (older cc versions)
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const oauth = creds?.claudeAiOauth;

    if (oauth?.accessToken) {
      const hoursLeft = checkExpiry(oauth.expiresAt, '.credentials.json');
      console.log(`🔑 Token source: ~/.claude/.credentials.json (${hoursLeft}h remaining)`);
      return oauth.accessToken;
    }
  } catch {
    // File not found or not parseable — fall through
  }

  // Nothing found
  console.error('❌ No OAuth token found. Options:');
  console.error('   1. Run "claude" in terminal to authenticate (stores in Keychain)');
  console.error('   2. Set CLAUDE_CODE_OAUTH_TOKEN in .env');
  console.error('   3. Run "node extract-token.mjs --export" and eval the output');
  process.exit(1);
}

// ─────────────────────────────────────────────────────
// Workspace Setup
// ─────────────────────────────────────────────────────

export function createWorkspace() {
  // On macOS, os.tmpdir() returns /var/folders/... which Docker Sandbox cannot
  // sync into the microVM (not in Docker Desktop's file sharing config).
  // /tmp on macOS resolves to /private/tmp, which IS accessible in Docker.
  const base = process.platform === 'darwin' ? realpathSync('/tmp') : tmpdir();
  const dir = mkdtempSync(join(base, 'cc-docker-demo-'));
  // On Linux, mkdtempSync creates with 0700. Docker's agent user can't write
  // to a directory owned by the host user. Make it world-writable.
  if (process.platform !== 'darwin') chmodSync(dir, 0o777);

  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'docker-test-project',
    version: '1.0.0',
    type: 'module'
  }, null, 2));

  console.log(`📁 Workspace: ${dir}`);
  return dir;
}

// ─────────────────────────────────────────────────────
// Post-run: show workspace contents
// ─────────────────────────────────────────────────────

export function showWorkspaceResults(workspace) {
  console.log('');
  console.log('📁 Files in workspace after cc execution:');
  try {
    const files = execSync(`ls -la ${workspace}`).toString();
    console.log(files);
  } catch {
    console.log('   (could not list files)');
  }

  // Show the generated file if it exists
  try {
    const hello = readFileSync(join(workspace, 'hello.mjs'), 'utf-8');
    console.log('📄 Content of hello.mjs (created by cc):');
    console.log('─'.repeat(40));
    console.log(hello);
    console.log('─'.repeat(40));
  } catch {
    // cc might have named it differently
  }
}

// ─────────────────────────────────────────────────────
// Runtime detection
// ─────────────────────────────────────────────────────

export function detectRuntimes() {
  const runtimes = {};

  // Check plain Docker
  try {
    execSync('docker --version 2>/dev/null', { stdio: 'pipe' });
    runtimes.docker = true;
  } catch {
    runtimes.docker = false;
  }

  // Check Docker Sandbox support (Docker Desktop 4.58+)
  try {
    execSync('docker sandbox version 2>/dev/null', { stdio: 'pipe' });
    runtimes.sandbox = true;
  } catch {
    runtimes.sandbox = false;
  }

  // Check Podman
  try {
    execSync('podman --version 2>/dev/null', { stdio: 'pipe' });
    runtimes.podman = true;
  } catch {
    runtimes.podman = false;
  }

  // Check fly CLI (fly.io remote execution)
  try {
    execSync('fly version 2>/dev/null', { stdio: 'pipe' });
    runtimes.fly = true;
  } catch {
    runtimes.fly = false;
  }

  // Check code-on-incus (koi) — Mode D: Incus system container isolation
  // Open-source alternative to Docker Sandbox; persistent state, UID mapping
  // On macOS: requires K Lima → Incus → koi (inception-style nesting)
  // https://github.com/code-on-incus/koi
  try {
    execSync('koi --version 2>/dev/null', { stdio: 'pipe' });
    runtimes.incus = true;
  } catch {
    runtimes.incus = false;
  }

  return runtimes;
}
