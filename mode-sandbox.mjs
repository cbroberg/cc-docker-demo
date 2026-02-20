// mode-sandbox.mjs
// Mode B: Run cc inside Docker Sandbox (microVM-based isolation)
// Uses: docker sandbox run claude [agent-options]
// Requires: Docker Desktop 4.58+ (macOS or Windows)
//
// Key differences from Mode A:
//   - microVM isolation (separate kernel, not shared)
//   - Credentials injected via docker sandbox exec → ~/.claude/.credentials.json
//   - Built-in network allow/deny lists
//   - No custom Dockerfile needed — Docker provides the agent template
//   - Workspace syncs at same absolute path (not volume mount)
//
// Persistence: uses a fixed sandbox name (cpm-demo-persistent) so credentials
// survive between runs. Credentials are re-injected from macOS Keychain before
// each run, so the 29h token rotation is handled automatically.
//
// Useful lifecycle commands:
//   docker sandbox ls                             — list all sandboxes (NOT in docker ps)
//   docker sandbox exec -it cpm-demo-persistent bash  — debug shell inside sandbox
//   docker sandbox rm cpm-demo-persistent         — delete sandbox (forces recreation)
//
// Docker-in-Docker: add --mount-docker to give the agent access to the host Docker daemon.
// This is equivalent to root access — only use when you fully trust the agent's actions.

import { spawn, spawnSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { showWorkspaceResults, TEST_PROMPT } from './lib/common.mjs';

const MAX_TURNS = 20;
const SANDBOX_NAME = 'cpm-demo-persistent';
const SANDBOX_WORKSPACE = '/private/tmp/cpm-sandbox-workspace';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function checkSandboxAvailable() {
  try {
    const version = execSync('docker sandbox version 2>&1', { encoding: 'utf-8' }).trim();
    console.log(`🏗️  Docker Sandbox: ${version}`);
    return true;
  } catch {
    console.error('❌ Docker Sandbox not available.');
    console.error('   Requires Docker Desktop 4.58+ (macOS or Windows).');
    console.error('   Install/upgrade: https://www.docker.com/products/docker-desktop/');
    return false;
  }
}

function sandboxExists() {
  try {
    const output = execSync('docker sandbox ls 2>/dev/null', { encoding: 'utf-8' });
    return output.split('\n').some(line => line.includes(SANDBOX_NAME));
  } catch {
    return false;
  }
}

function readHostCredentials() {
  // Priority 1: macOS Keychain (Claude Code 2025+)
  if (process.platform === 'darwin') {
    try {
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const creds = JSON.parse(raw);
      if (creds?.claudeAiOauth?.accessToken) {
        const hoursLeft = ((creds.claudeAiOauth.expiresAt - Date.now()) / 3600000).toFixed(1);
        console.log(`🔑 Credentials: macOS Keychain (${hoursLeft}h remaining)`);
        return raw;
      }
    } catch { /* fall through */ }
  }

  // Priority 2: legacy credentials file
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const raw = readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    if (creds?.claudeAiOauth?.accessToken) {
      console.log('🔑 Credentials: ~/.claude/.credentials.json');
      return raw;
    }
  } catch { /* fall through */ }

  throw new Error('No Claude credentials found. Run "claude" to authenticate first.');
}

function injectCredentials() {
  const credsJson = readHostCredentials();
  const claudeJson = JSON.stringify({ hasCompletedOnboarding: true });

  // Write credentials.json into sandbox via stdin pipe (-i = keep stdin open)
  const r1 = spawnSync('docker', [
    'sandbox', 'exec', '-i', SANDBOX_NAME,
    'bash', '-c', 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json'
  ], { input: credsJson, encoding: 'utf-8' });

  if (r1.status !== 0) {
    throw new Error(`Failed to inject credentials: ${r1.stderr}`);
  }

  // Write ~/.claude.json (skip onboarding prompt)
  const r2 = spawnSync('docker', [
    'sandbox', 'exec', '-i', SANDBOX_NAME,
    'bash', '-c', 'cat > ~/.claude.json'
  ], { input: claudeJson, encoding: 'utf-8' });

  if (r2.status !== 0) {
    throw new Error(`Failed to write ~/.claude.json: ${r2.stderr}`);
  }

  console.log('   Credentials injected into sandbox.');
}

function ensureSandboxReady() {
  if (sandboxExists()) {
    console.log(`♻️  Reusing persistent sandbox: ${SANDBOX_NAME}`);
  } else {
    console.log(`🆕 Creating persistent sandbox: ${SANDBOX_NAME}`);

    // Ensure workspace exists on host
    mkdirSync(SANDBOX_WORKSPACE, { recursive: true });

    // Create sandbox by running --version (no auth needed, exits cleanly)
    const create = spawnSync('docker', [
      'sandbox', 'run', '--name', SANDBOX_NAME,
      'claude', SANDBOX_WORKSPACE,
      '--', '--version'
    ], { stdio: 'pipe', encoding: 'utf-8' });

    if (create.status !== 0) {
      throw new Error(`Failed to create sandbox: ${create.stderr}`);
    }
    console.log('   Sandbox created.');
  }

  // Inject fresh credentials from host Keychain (handles token rotation automatically)
  injectCredentials();
}

function prepareWorkspace() {
  mkdirSync(SANDBOX_WORKSPACE, { recursive: true });
  writeFileSync(join(SANDBOX_WORKSPACE, 'package.json'), JSON.stringify({
    name: 'docker-test-project',
    version: '1.0.0',
    type: 'module'
  }, null, 2));
  return SANDBOX_WORKSPACE;
}

export async function runModeSandbox() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Mode B: Docker Sandbox (microVM)               ║');
  console.log('║  Isolation: microVM (dedicated kernel)           ║');
  console.log('║  Auth: Keychain → sandbox exec injection         ║');
  console.log('║  Network: Built-in allow/deny lists              ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Check sandbox available
  if (!checkSandboxAvailable()) {
    return { mode: 'sandbox', exitCode: 1, error: 'Docker Sandbox not available' };
  }

  // 2. Ensure sandbox exists and credentials are fresh
  try {
    ensureSandboxReady();
  } catch (err) {
    console.error(`❌ ${err.message}`);
    return { mode: 'sandbox', exitCode: 1, error: err.message };
  }

  // 3. Prepare workspace
  const workspace = prepareWorkspace();

  // 4. Build run command (reconnect to existing sandbox)
  const args = [
    'sandbox', 'run',
    SANDBOX_NAME,
    '--',
    '-p',                                // Headless prompt mode
    '--dangerously-skip-permissions',    // YOLO mode
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'text',
    TEST_PROMPT,
  ];

  console.log('');
  console.log(`🚀 Running cc in Docker Sandbox microVM...`);
  console.log(`   Sandbox:    ${SANDBOX_NAME} (persistent)`);
  console.log(`   Max turns:  ${MAX_TURNS}`);
  console.log(`   Workspace:  ${workspace}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  CC OUTPUT (from microVM)');
  console.log('─'.repeat(60));
  console.log('');

  // 5. Spawn and stream
  const startTime = Date.now();

  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (text.trim()) {
        process.stderr.write(`   [sandbox] ${text}`);
      }
    });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => reject(new Error(`Failed to spawn docker sandbox: ${err.message}`)));
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  // 6. Report
  console.log('');
  console.log('─'.repeat(60));
  console.log('');
  console.log(result.code === 0
    ? `✅ Mode B completed successfully (${elapsed}s)`
    : `❌ Mode B exited with code ${result.code} (${elapsed}s)`
  );

  if (result.code !== 0 && result.stderr) {
    console.log('');
    console.log('Stderr output:');
    console.log(result.stderr.slice(0, 1000));
  }

  showWorkspaceResults(workspace);

  console.log('');
  console.log(`📦 Sandbox preserved: ${SANDBOX_NAME}`);
  console.log(`   To inspect: docker sandbox exec -it ${SANDBOX_NAME} bash`);
  console.log(`   To reset:   docker sandbox rm ${SANDBOX_NAME}`);

  return { mode: 'sandbox', exitCode: result.code, elapsed, workspace };
}

// Allow standalone execution
if (process.argv[1]?.endsWith('mode-sandbox.mjs')) {
  runModeSandbox().catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
  });
}
