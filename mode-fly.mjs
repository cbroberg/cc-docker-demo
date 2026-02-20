// mode-fly.mjs
// Mode C: Run cc on a Fly.io ephemeral machine
//
// Auth: token passed via --env to fly machine run (sent over HTTPS to Fly API,
//       not visible in logs). fly secrets cannot be used for apps with no
//       persistent machines — secrets get staged but never deployed.
//
// Build: docker build --platform linux/amd64 + docker push to registry.fly.io
//        fly auth docker is run automatically before push.
//        Image ref is saved to .fly-image-ref after each build.
//
// Run:   fly machine run <image-ref> --rm  (auto-deleted after cc exits)
//        Container output streamed via fly logs (fly machine run doesn't pipe stdio)
//
// Usage:
//   npm run fly:build    ← build + push image (one-time, repeat when Dockerfile changes)
//   npm run fly          ← run cc on Fly.io

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveToken, TEST_PROMPT } from './lib/common.mjs';
import 'dotenv/config';

const MAX_TURNS = 20;
const IMAGE_REF_FILE = new URL('./.fly-image-ref', import.meta.url);

// ─────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────

function getFlyConfig() {
  let app = process.env.FLY_APP;
  let org = process.env.FLY_ORG;
  const region = process.env.FLY_REGION || 'arn';

  if (!app || !org) {
    try {
      const toml = readFileSync(new URL('./fly.toml', import.meta.url), 'utf-8');
      if (!app) {
        const m = toml.match(/^app\s*=\s*["']?([^"'\s#]+)/m);
        if (m?.[1] && m[1] !== 'cpm-runner') app = m[1];
      }
      if (!org) {
        const m = toml.match(/^org\s*=\s*["']?([^"'\s#]+)/m);
        if (m?.[1] && m[1] !== 'personal') org = m[1];
      }
    } catch { /* no fly.toml */ }
  }

  return { app, org, region };
}

function getSavedImageRef() {
  try { return readFileSync(IMAGE_REF_FILE, 'utf-8').trim() || null; }
  catch { return null; }
}

// ─────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────

export async function buildFlyImage(appName) {
  const imageRef = `registry.fly.io/${appName}:demo`;
  const cwd = new URL('.', import.meta.url).pathname;

  console.log(`🔨 Building image ${imageRef} (linux/amd64)...`);
  const build = spawnSync('docker', ['build', '--platform', 'linux/amd64', '-t', imageRef, '.'], { stdio: 'inherit', cwd });
  if (build.status !== 0) throw new Error('docker build failed');

  console.log(`\n🔐 Authenticating with Fly registry...`);
  const auth = spawnSync('fly', ['auth', 'docker'], { stdio: 'inherit' });
  if (auth.status !== 0) throw new Error('fly auth docker failed');

  console.log(`\n📤 Pushing ${imageRef} to Fly.io registry...`);
  const push = spawnSync('docker', ['push', imageRef], { stdio: 'inherit' });
  if (push.status !== 0) throw new Error('docker push failed');

  writeFileSync(IMAGE_REF_FILE, imageRef);
  console.log(`\n✅ Image ready: ${imageRef}`);
  return imageRef;
}

// ─────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────

export async function runModeFly(options = {}) {
  const { app, org, region } = getFlyConfig();

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Mode C: Fly.io Ephemeral Machine               ║');
  console.log('║  Isolation: Firecracker microVM (Fly.io)         ║');
  console.log('║  Auth: --env (HTTPS to Fly API, not in logs)     ║');
  console.log('║  Lifecycle: Ephemeral (auto-deleted after run)   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');

  // 1. Validate config
  if (!app) {
    console.error('❌ App name not set. Update fly.toml or set FLY_APP in .env');
    return { mode: 'fly', exitCode: 1 };
  }
  console.log(`📡 App: ${app}  Org: ${org ?? 'personal'}  Region: ${region}`);

  // 2. Build if requested
  if (options.build) {
    await buildFlyImage(app);
  }

  // 3. Get image ref
  const image = getSavedImageRef();
  if (!image) {
    console.error('❌ No image ref found. Run: npm run fly:build');
    return { mode: 'fly', exitCode: 1 };
  }
  console.log(`🐳 Image: ${image}`);

  // 4. Resolve token (injected via --env, not fly secrets)
  const token = resolveToken();
  console.log('🔑 Token ready (will be passed via --env to Fly API over HTTPS)');

  // 5. Launch machine
  console.log('');
  console.log(`🚀 Launching machine on Fly.io (${region})...`);
  console.log(`   Max turns: ${MAX_TURNS}`);
  console.log('');
  console.log('─'.repeat(60));
  console.log('  CC OUTPUT (from Fly.io)');
  console.log('─'.repeat(60));
  console.log('');

  const args = [
    'machine', 'run', image,
    '--app', app,
    '--env', `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '--env', 'CLAUDE_CODE_ENABLE_TASKS=1',
    '--region', region,
    '--vm-memory', '2048',
    '--rm',
    ...(org ? ['--org', org] : []),
    '--',
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'text',
    TEST_PROMPT,
  ];

  // fly machine run --rm returns when the machine STARTS, not when it exits.
  // We stream fly logs and watch for the exit signal from the specific machine.
  let machineId = null;
  let resolveExit;
  const machineExited = new Promise(resolve => { resolveExit = resolve; });

  const logProc = spawn('fly', ['logs', '--app', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  logProc.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    // Detect machine exit: "machine restart policy set to 'no', not restarting"
    if (machineId && chunk.toString().includes(`runner[${machineId}]`) &&
        chunk.toString().includes('machine restart policy')) {
      resolveExit();
    }
  });

  // Give fly logs a moment to connect
  await new Promise(r => setTimeout(r, 1500));

  const startTime = Date.now();

  // Launch machine (returns when machine starts, not exits)
  const result = await new Promise((resolve, reject) => {
    const proc = spawn('fly', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // Machine ID is in stdout — parse it so we can detect exit in the log stream
    proc.stdout.on('data', chunk => {
      const m = chunk.toString().match(/Machine ID:\s*([a-z0-9]+)/);
      if (m?.[1]) machineId = m[1];
    });
    proc.stderr.on('data', chunk => process.stderr.write(`   [fly] ${chunk}`));
    proc.on('close', code => resolve({ code }));
    proc.on('error', err => reject(new Error(`fly spawn failed: ${err.message}`)));
  });

  // Wait for machine exit signal in logs (max 5 minutes)
  await Promise.race([machineExited, new Promise(r => setTimeout(r, 5 * 60 * 1000))]);

  // Flush remaining log lines
  await new Promise(r => setTimeout(r, 2000));
  logProc.kill();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('─'.repeat(60));
  console.log('');
  console.log(result.code === 0
    ? `✅ Mode C completed (${elapsed}s)`
    : `❌ Mode C exited with code ${result.code} (${elapsed}s)`
  );

  return { mode: 'fly', exitCode: result.code, elapsed };
}

// ─────────────────────────────────────────────────────
// Standalone
// ─────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('mode-fly.mjs')) {
  const { app } = getFlyConfig();

  if (process.argv.includes('--build-only')) {
    if (!app) { console.error('❌ Set FLY_APP or update fly.toml'); process.exit(1); }
    buildFlyImage(app).catch(err => { console.error('💥', err.message); process.exit(1); });

  } else {
    const build = process.argv.includes('--build');
    runModeFly({ build }).catch(err => { console.error('💥', err.message); process.exit(1); });
  }
}
