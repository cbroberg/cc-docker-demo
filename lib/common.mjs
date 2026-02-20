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
// ─────────────────────────────────────────────────────

export function resolveToken() {
  // Priority 1: .env file / environment
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('🔑 Token source: environment variable');
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // Priority 2: Auto-extract from cc credentials
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const token = creds.claudeAiOauth?.accessToken;

    if (!token) throw new Error('No accessToken in credentials');

    const expiresAt = new Date(creds.claudeAiOauth.expiresAt);
    const hoursLeft = ((expiresAt - new Date()) / 3600000).toFixed(1);

    if (hoursLeft <= 0) {
      console.error('❌ OAuth token expired. Run "claude" to refresh, then retry.');
      process.exit(1);
    }

    console.log(`🔑 Token source: ~/.claude/.credentials.json (${hoursLeft}h remaining)`);
    return token;
  } catch (err) {
    console.error('❌ No token found. Either:');
    console.error('   1. Set CLAUDE_CODE_OAUTH_TOKEN in .env');
    console.error('   2. Run "node extract-token.mjs" to get your token');
    console.error('   3. Or authenticate with "claude" first');
    process.exit(1);
  }
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
