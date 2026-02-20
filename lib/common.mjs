// lib/common.mjs
// Shared utilities for both Docker and Docker Sandbox modes

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function checkExpiry(expiresAt, source) {
  const hoursLeft = ((expiresAt - Date.now()) / 3600000).toFixed(1);
  if (hoursLeft <= 0) {
    console.error(`❌ OAuth token expired (from ${source}). Run "claude" to refresh.`);
    process.exit(1);
  }
  if (hoursLeft < 1) {
    console.warn(`⚠️  Token expires in ${hoursLeft}h — consider refreshing`);
  }
  return hoursLeft;
}

export function resolveToken() {
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
  const dir = mkdtempSync(join(tmpdir(), 'cc-docker-demo-'));

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

  return runtimes;
}
