// run-demo.mjs
// CPM Docker Demo — Test cc execution in both Docker and Docker Sandbox
//
// Usage:
//   node run-demo.mjs                   # Auto-detect and run available modes
//   node run-demo.mjs --mode docker     # Mode A only (plain Docker/Podman)
//   node run-demo.mjs --mode sandbox    # Mode B only (Docker Sandbox microVM)
//   node run-demo.mjs --mode both       # Run both and compare
//   node run-demo.mjs --mode docker --runtime podman  # Use Podman instead

import 'dotenv/config';
import { detectRuntimes } from './lib/common.mjs';
import { runModeDocker } from './mode-docker.mjs';
import { runModeSandbox } from './mode-sandbox.mjs';

// ─────────────────────────────────────────────────────
// Parse CLI args
// ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mode: 'auto', runtime: 'docker' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) opts.mode = args[++i];
    if (args[i] === '--runtime' && args[i + 1]) opts.runtime = args[++i];
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
CPM Docker Demo — Test cc execution modes

Usage:
  node run-demo.mjs [options]

Options:
  --mode <mode>       docker | sandbox | both | auto (default: auto)
  --runtime <rt>      docker | podman (default: docker, Mode A only)
  --help, -h          Show this help

Modes:
  docker    Mode A: Plain Docker/Podman container (shared kernel)
            Requires: Docker Engine or Podman + Dockerfile build
            Auth: CLAUDE_CODE_OAUTH_TOKEN env var

  sandbox   Mode B: Docker Sandbox microVM (dedicated kernel)
            Requires: Docker Desktop 4.58+ (macOS/Windows)
            Auth: Docker Desktop host-side proxy (automatic)

  both      Run both modes sequentially and compare results

  auto      Detect available runtimes and run what's possible
`);
      process.exit(0);
    }
  }

  return opts;
}

// ─────────────────────────────────────────────────────
// Runtime Detection & Banner
// ─────────────────────────────────────────────────────

function printBanner(runtimes) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              CPM v4 Docker Demo — cc in Container           ║');
  console.log('║                                                             ║');
  console.log('║  Tests Claude Code execution in isolated environments       ║');
  console.log('║  using Max plan OAuth authentication                        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Docker Engine:    ${runtimes.docker  ? '✅ Available' : '❌ Not found'}                             ║`);
  console.log(`║  Docker Sandbox:   ${runtimes.sandbox ? '✅ Available' : '⬜ Not found (needs Docker Desktop 4.58+)'}  ║`);
  console.log(`║  Podman:           ${runtimes.podman  ? '✅ Available' : '⬜ Not found'}                             ║`);
  console.log(`║  Fly.io CLI:       ${runtimes.fly     ? '✅ Available' : '⬜ Not found (brew install flyctl)'}                  ║`);
  console.log(`║  Incus/koi:        ${runtimes.incus   ? '✅ Available' : '⬜ Not found (see docs/sandbox-tool-claude-code-incus.txt)'}  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ─────────────────────────────────────────────────────
// Comparison Report
// ─────────────────────────────────────────────────────

function printComparison(results) {
  console.log('');
  console.log('═'.repeat(60));
  console.log('  COMPARISON REPORT');
  console.log('═'.repeat(60));
  console.log('');
  console.log('┌────────────────────┬──────────────────┬──────────────────┐');
  console.log('│ Property           │ Mode A: Docker   │ Mode B: Sandbox  │');
  console.log('├────────────────────┼──────────────────┼──────────────────┤');

  const a = results.find(r => r.mode === 'docker');
  const b = results.find(r => r.mode === 'sandbox');

  const row = (label, valA, valB) => {
    const l = label.padEnd(18);
    const va = (valA || '—').toString().padEnd(16);
    const vb = (valB || '—').toString().padEnd(16);
    console.log(`│ ${l} │ ${va} │ ${vb} │`);
  };

  row('Isolation',       'Container',          'microVM');
  row('Kernel',          'Shared w/ host',     'Dedicated');
  row('Exit code',       a?.exitCode,          b?.exitCode);
  row('Duration',        a ? `${a.elapsed}s` : null,  b ? `${b.elapsed}s` : null);
  row('Auth method',     'OAuth env var',      'Host proxy');
  row('Network control', 'Manual',             'Built-in allow/deny');
  row('Docker-in-Docker', 'No',               'Yes (private daemon)');
  row('Custom image',    'Yes (Dockerfile)',   'Optional (--template)');
  row('Requires',        'Docker/Podman',      'Docker Desktop 4.58+');

  console.log('└────────────────────┴──────────────────┴──────────────────┘');
  console.log('');

  // CPM v4 implications
  console.log('┌──────────────────────────────────────────────────────────┐');
  console.log('│  CPM v4 Implications                                    │');
  console.log('├──────────────────────────────────────────────────────────┤');
  console.log('│  • Mode A → v4 Phase 2: Container sandbox for CI/CD,   │');
  console.log('│    Linux servers, Podman environments                   │');
  console.log('│  • Mode B → v4 Phase 2: Preferred for local dev on     │');
  console.log('│    macOS/Windows (strongest isolation, auto-auth)       │');
  console.log('│  • Token Refresh Sidecar only needed for Mode A        │');
  console.log('│    (Mode B proxy handles credentials automatically)    │');
  console.log('│  • Network allowlist built-in for Mode B, manual for A │');
  console.log('└──────────────────────────────────────────────────────────┘');
  console.log('');
}

// ─────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const runtimes = detectRuntimes();

  printBanner(runtimes);

  // Determine which modes to run
  let runDocker = false;
  let runSandbox = false;

  switch (opts.mode) {
    case 'docker':
      runDocker = true;
      break;
    case 'sandbox':
      runSandbox = true;
      break;
    case 'both':
      runDocker = true;
      runSandbox = true;
      break;
    case 'auto':
    default:
      // Auto-detect: run whatever is available
      if (runtimes.sandbox) runSandbox = true;
      if (runtimes.docker || runtimes.podman) runDocker = true;
      if (!runDocker && !runSandbox) {
        console.error('❌ No container runtime found. Install Docker or Podman.');
        process.exit(1);
      }
      break;
  }

  // Validate runtime
  if (runDocker && opts.runtime === 'podman' && !runtimes.podman) {
    console.error('❌ Podman requested but not found.');
    process.exit(1);
  }
  if (runDocker && opts.runtime === 'docker' && !runtimes.docker && runtimes.podman) {
    console.log('ℹ️  Docker not found, falling back to Podman');
    opts.runtime = 'podman';
  }
  if (runSandbox && !runtimes.sandbox) {
    console.error('❌ Docker Sandbox requested but not available.');
    console.error('   Requires Docker Desktop 4.58+ (macOS or Windows).');
    if (runDocker) {
      console.log('   Continuing with Mode A (Docker) only...');
      runSandbox = false;
    } else {
      process.exit(1);
    }
  }

  const results = [];

  // Run Mode A
  if (runDocker) {
    try {
      const result = await runModeDocker({ runtime: opts.runtime });
      results.push(result);
    } catch (err) {
      console.error(`💥 Mode A failed: ${err.message}`);
      results.push({ mode: 'docker', exitCode: -1, error: err.message });
    }
  }

  // Run Mode B
  if (runSandbox) {
    if (results.length > 0) {
      console.log('');
      console.log('═'.repeat(60));
      console.log('  Switching to Mode B...');
      console.log('═'.repeat(60));
    }

    try {
      const result = await runModeSandbox();
      results.push(result);
    } catch (err) {
      console.error(`💥 Mode B failed: ${err.message}`);
      results.push({ mode: 'sandbox', exitCode: -1, error: err.message });
    }
  }

  // Print comparison if both ran
  if (results.length > 1) {
    printComparison(results);
  }

  // Summary
  console.log('');
  const allPassed = results.every(r => r.exitCode === 0);
  if (allPassed) {
    console.log('🎉 All modes completed successfully!');
  } else {
    console.log('⚠️  Some modes had issues — check output above.');
  }
}

main().catch(err => {
  console.error('💥 Fatal error:', err.message);
  process.exit(1);
});
