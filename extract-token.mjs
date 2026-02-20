#!/usr/bin/env node

/**
 * extract-token.mjs
 * 
 * Extracts Claude Code OAuth token from macOS Keychain
 * and writes it to .env file for Docker injection.
 * 
 * Usage:
 *   node extract-token.mjs              # Write to .env + show summary
 *   node extract-token.mjs --token-only  # Raw token to stdout (for piping)
 *   node extract-token.mjs --json        # Full JSON output
 *   node extract-token.mjs --no-write    # Show only, don't touch .env
 */

import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const ENV_FILE = '.env';
const ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

function getOAuth() {
  if (process.platform !== 'darwin') {
    console.error('❌ Requires macOS (Keychain access)');
    process.exit(1);
  }

  let raw;
  try {
    raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
  } catch {
    console.error(`❌ Keychain entry "${KEYCHAIN_SERVICE}" not found`);
    console.error('   Run "claude" in terminal first to authenticate.');
    process.exit(1);
  }

  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) {
    console.error('❌ No accessToken in Keychain data');
    process.exit(1);
  }

  const remainingMs = oauth.expiresAt - Date.now();
  if (remainingMs <= 0) {
    console.error('❌ Token EXPIRED — run "claude" to refresh');
    process.exit(1);
  }

  return { ...oauth, remainingHours: (remainingMs / 3600000).toFixed(1) };
}

function writeEnvFile(token) {
  const line = `${ENV_KEY}=${token}`;

  if (existsSync(ENV_FILE)) {
    let content = readFileSync(ENV_FILE, 'utf-8');
    const regex = new RegExp(`^${ENV_KEY}=.*$`, 'm');

    if (regex.test(content)) {
      content = content.replace(regex, line);
      writeFileSync(ENV_FILE, content);
      return 'updated';
    } else {
      writeFileSync(ENV_FILE, content.trimEnd() + '\n' + line + '\n');
      return 'appended';
    }
  } else {
    writeFileSync(ENV_FILE, line + '\n');
    return 'created';
  }
}

// ── Main ──
const oauth = getOAuth();
const mask = (t) => t.slice(0, 16) + '...' + t.slice(-6);

if (process.argv.includes('--token-only')) {
  process.stdout.write(oauth.accessToken);

} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    expiresIn: `${oauth.remainingHours}h`,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  }, null, 2));

} else {
  // Default: write to .env + show summary
  const noWrite = process.argv.includes('--no-write');

  if (!noWrite) {
    const action = writeEnvFile(oauth.accessToken);
    console.log(`✅ .env ${action} with ${ENV_KEY}`);
  }

  console.log(`🔑 Token:   ${mask(oauth.accessToken)}`);
  console.log(`⏰ Expires: ${new Date(oauth.expiresAt).toLocaleString()} (${oauth.remainingHours}h)`);
  console.log(`📋 Plan:    ${oauth.subscriptionType} (${oauth.rateLimitTier})`);

  if (!noWrite) {
    console.log('');
    console.log('   Ready to run: npm run docker');
  }
}

// ── Programmatic export ──
export function getToken() {
  const oauth = getOAuth();
  return oauth;
}
