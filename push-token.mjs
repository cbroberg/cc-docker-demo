// push-token.mjs
// Push Claude OAuth token from macOS Keychain to a remote machine via SSH.
//
// Usage:
//   node push-token.mjs [ssh-host]          # default host: ubuntu
//   npm run push-token                      # uses default host
//   npm run push-token -- myserver          # custom host
//
// What it does:
//   1. Reads CLAUDE_CODE_OAUTH_TOKEN from macOS Keychain (same as Mode A/C)
//   2. SSHes into the remote host
//   3. Writes the token to ~/cc-docker-demo/.env
//   4. Remote machine can then run: npm run docker
//
// Token lasts ~29h. Re-run this script when it expires.
// For automatic rotation, see: cpm watch (planned feature)

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_HOST = process.env.CPM_REMOTE_HOST || 'ubuntu';
const REMOTE_DIR = process.env.CPM_REMOTE_DIR || '$HOME/cc-docker-demo';

const host = process.argv[2] || DEFAULT_HOST;

// ─────────────────────────────────────────────────────
// 1. Resolve token from macOS Keychain
// ─────────────────────────────────────────────────────

function resolveToken() {
  if (process.platform !== 'darwin') {
    // On non-macOS, fall back to env var
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) return { token, hoursLeft: null, source: 'env var' };
    console.error('❌ push-token.mjs must run on macOS (reads from Keychain)');
    process.exit(1);
  }

  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;

    if (oauth?.accessToken) {
      const hoursLeft = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
      if (hoursLeft <= 0) {
        console.error('❌ Token expired. Run "claude" to refresh.');
        process.exit(1);
      }
      return { token: oauth.accessToken, hoursLeft, source: 'macOS Keychain' };
    }
  } catch { /* fall through */ }

  // Fallback: legacy credentials file
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
    const oauth = creds?.claudeAiOauth;
    if (oauth?.accessToken) {
      const hoursLeft = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
      return { token: oauth.accessToken, hoursLeft, source: '.credentials.json' };
    }
  } catch { /* fall through */ }

  console.error('❌ No token found. Run "claude" to authenticate.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────
// 2. Write .env on remote via SSH
// ─────────────────────────────────────────────────────

function pushToRemote(host, token, hoursLeft) {
  console.log(`📡 Target:  ${host}:${REMOTE_DIR}/.env`);
  console.log(`⏰ Expires: in ${hoursLeft}h`);
  console.log('');

  // Write .env file on remote — preserves existing vars, updates token line
  const script = `
    set -e
    mkdir -p ${REMOTE_DIR}
    ENV_FILE="${REMOTE_DIR}/.env"
    TOKEN_LINE="CLAUDE_CODE_OAUTH_TOKEN=${token}"

    if [ -f "$ENV_FILE" ]; then
      # Update existing token line if present, otherwise append
      if grep -q "^CLAUDE_CODE_OAUTH_TOKEN=" "$ENV_FILE"; then
        sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|$TOKEN_LINE|" "$ENV_FILE"
        echo "updated"
      else
        echo "" >> "$ENV_FILE"
        echo "$TOKEN_LINE" >> "$ENV_FILE"
        echo "appended"
      fi
    else
      echo "$TOKEN_LINE" > "$ENV_FILE"
      echo "created"
    fi
  `;

  const result = spawnSync('ssh', [host, 'bash', '-s'], {
    input: script,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    console.error(`❌ SSH failed: ${result.stderr || result.error?.message}`);
    process.exit(1);
  }

  const action = result.stdout.trim();
  console.log(`✅ Token ${action} on ${host}`);
  console.log(`   File: ${REMOTE_DIR}/.env`);
  console.log('');
  console.log('Remote is ready. On the Ubuntu box:');
  console.log(`   cd ${REMOTE_DIR} && npm run docker`);
}

// ─────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────

console.log('');
console.log('🔑 Pushing Claude token to remote host...');
console.log('');

const { token, hoursLeft, source } = resolveToken();
console.log(`🔑 Source:  ${source}`);

pushToRemote(host, token, hoursLeft);
