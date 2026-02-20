// mode-sandbox.mjs
// Mode B: Run cc inside Docker Sandbox (microVM-based isolation)
// Uses: docker sandbox run claude [agent-options]
// Requires: Docker Desktop 4.58+ (macOS or Windows)
//
// Key differences from Mode A:
//   - microVM isolation (separate kernel, not shared)
//   - Credentials handled by Docker Desktop's host-side proxy
//   - Built-in network allow/deny lists
//   - No custom Dockerfile needed — Docker provides the agent template
//   - Workspace syncs at same absolute path (not volume mount)
//   - No CLAUDE_CODE_OAUTH_TOKEN needed if already logged into claude

import { spawn, execSync } from 'node:child_process';
import { createWorkspace, showWorkspaceResults, TEST_PROMPT } from './lib/common.mjs';

const MAX_TURNS = 20;
const SANDBOX_NAME = `cpm-demo-${Date.now()}`;

function checkSandboxAvailable() {
  try {
    const version = execSync('docker sandbox version 2>&1', { encoding: 'utf-8' }).trim();
    console.log(`🏗️  Docker Sandbox: ${version}`);
    return true;
  } catch {
    console.error('❌ Docker Sandbox not available.');
    console.error('   Requires Docker Desktop 4.58+ (macOS or Windows).');
    console.error('   Install/upgrade: https://www.docker.com/products/docker-desktop/');
    console.error('');
    console.error('   On Linux: Docker Sandbox is experimental (single user, UID 1000 only).');
    return false;
  }
}

function checkCredentials() {
  // Docker Sandbox uses a host-side proxy for credential injection.
  // If ANTHROPIC_API_KEY is set globally, the proxy injects it automatically.
  // For Claude Max plan: user must be logged in to claude via `claude` CLI first.
  //
  // The sandbox daemon reads env vars from shell config (~/.bashrc, ~/.zshrc),
  // NOT from the current shell session. This is a known gotcha.

  console.log('🔑 Credentials: Docker Sandbox host-side proxy');
  console.log('   (Docker Desktop injects credentials automatically)');
  console.log('   If auth fails: run "claude" on host to login, then restart Docker Desktop.');
}

export async function runModeSandbox() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Mode B: Docker Sandbox (microVM)               ║');
  console.log('║  Isolation: microVM (dedicated kernel)           ║');
  console.log('║  Auth: Docker Desktop host-side proxy            ║');
  console.log('║  Network: Built-in allow/deny lists              ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Check sandbox available
  if (!checkSandboxAvailable()) {
    return { mode: 'sandbox', exitCode: 1, error: 'Docker Sandbox not available' };
  }

  // 2. Check credentials
  checkCredentials();

  // 3. Create workspace
  const workspace = createWorkspace();

  // 4. Build sandbox run command
  //    Syntax: docker sandbox run [options] <agent> [agent-options]
  //    Agent options are passed after 'claude' and forwarded to cc
  const args = [
    'sandbox', 'run',
    '--name', SANDBOX_NAME,
    '--workspace', workspace,
    // Agent: claude
    'claude',
    // Agent options (forwarded to cc inside the sandbox):
    '-p',                                // Headless prompt mode
    '--dangerously-skip-permissions',    // YOLO mode
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'text',
    TEST_PROMPT,
  ];

  console.log('');
  console.log(`🚀 Spawning cc in Docker Sandbox microVM...`);
  console.log(`   Sandbox:    ${SANDBOX_NAME}`);
  console.log(`   Max turns:  ${MAX_TURNS}`);
  console.log(`   Workspace:  ${workspace}`);
  console.log('');
  console.log('   ℹ️  First run may take 1-2 min (pulling microVM template image)');
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
      // Show all stderr for sandbox mode — useful for debugging
      if (text.trim()) {
        process.stderr.write(`   [sandbox] ${text}`);
      }
    });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => reject(new Error(`Failed to spawn docker sandbox: ${err.message}`)));
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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

  // 7. Cleanup sandbox
  console.log('');
  console.log(`🧹 Cleaning up sandbox: ${SANDBOX_NAME}`);
  try {
    execSync(`docker sandbox rm ${SANDBOX_NAME} 2>/dev/null`, { stdio: 'pipe' });
    console.log('   Sandbox removed.');
  } catch {
    console.log(`   Note: run "docker sandbox rm ${SANDBOX_NAME}" to clean up manually.`);
  }

  console.log(`📁 Workspace preserved at: ${workspace}`);

  return { mode: 'sandbox', exitCode: result.code, elapsed, workspace };
}

// Allow standalone execution
if (process.argv[1]?.endsWith('mode-sandbox.mjs')) {
  runModeSandbox().catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
  });
}
