// mode-docker.mjs
// Mode A: Run cc inside a plain Docker container
// Uses: Dockerfile + CLAUDE_CODE_OAUTH_TOKEN + --dangerously-skip-permissions
// Works with: Docker Engine, Docker Desktop, Podman

import { spawn, execSync } from 'node:child_process';
import { resolveToken, createWorkspace, showWorkspaceResults, TEST_PROMPT } from './lib/common.mjs';

const DOCKER_IMAGE = 'cpm-runner:demo';
const MAX_TURNS = 20;

function ensureImage(runtime) {
  try {
    execSync(`${runtime} image inspect ${DOCKER_IMAGE} > /dev/null 2>&1`);
    console.log(`🐳 Image ${DOCKER_IMAGE} already exists`);
  } catch {
    console.log(`🔨 Building ${DOCKER_IMAGE} with ${runtime}...`);
    execSync(`${runtime} build -t ${DOCKER_IMAGE} .`, { stdio: 'inherit' });
    console.log(`✅ Image built`);
  }
}

export async function runModeDocker(options = {}) {
  const runtime = options.runtime || 'docker'; // 'docker' or 'podman'

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  Mode A: Plain ${runtime.padEnd(7)} container                ║`);
  console.log('║  Isolation: Container (shared kernel)            ║');
  console.log('║  Auth: CLAUDE_CODE_OAUTH_TOKEN env var           ║');
  console.log('║  Permissions: --dangerously-skip-permissions     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Resolve OAuth token
  const token = resolveToken();

  // 2. Ensure Docker image exists
  ensureImage(runtime);

  // 3. Create temp workspace
  const workspace = createWorkspace();

  // 4. Build run args
  const args = [
    'run',
    '--rm',
    '-w', '/workspace',
    '-v', `${workspace}:/workspace`,
    '-e', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-e', 'CLAUDE_CODE_ENABLE_TASKS=1',
    DOCKER_IMAGE,
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'text',
    TEST_PROMPT,
  ];

  console.log(`🚀 Spawning cc in ${runtime} container...`);
  console.log(`   Image:      ${DOCKER_IMAGE}`);
  console.log(`   Max turns:  ${MAX_TURNS}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  CC OUTPUT');
  console.log('─'.repeat(60));
  console.log('');

  // 5. Spawn and stream
  const startTime = Date.now();

  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (text.includes('Error') || text.includes('error')) {
        process.stderr.write(`⚠️  ${text}`);
      }
    });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => reject(new Error(`Failed to spawn ${runtime}: ${err.message}`)));
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 6. Report
  console.log('');
  console.log('─'.repeat(60));
  console.log('');
  console.log(result.code === 0
    ? `✅ Mode A completed successfully (${elapsed}s)`
    : `❌ Mode A exited with code ${result.code} (${elapsed}s)`
  );

  if (result.code !== 0 && result.stderr) {
    console.log('Stderr:', result.stderr.slice(0, 500));
  }

  showWorkspaceResults(workspace);
  console.log(`🧹 Workspace: ${workspace}`);

  return { mode: 'docker', runtime, exitCode: result.code, elapsed, workspace };
}

// Allow standalone execution
if (process.argv[1]?.endsWith('mode-docker.mjs')) {
  const runtime = process.argv[2] || 'docker';
  runModeDocker({ runtime }).catch(err => {
    console.error('💥 Fatal:', err.message);
    process.exit(1);
  });
}
