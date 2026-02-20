// extract-token.mjs
// Reads the Claude Code OAuth access token from ~/.claude/.credentials.json
// Use this to populate your .env file

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

try {
  const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;

  if (!oauth?.accessToken) {
    console.error('❌ No OAuth token found. Run "claude" first to authenticate.');
    process.exit(1);
  }

  const expiresAt = new Date(oauth.expiresAt);
  const now = new Date();
  const hoursLeft = ((expiresAt - now) / 1000 / 60 / 60).toFixed(1);

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Claude Code OAuth Token                        ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Token:   ${oauth.accessToken.slice(0, 20)}...`);
  console.log(`║  Expires: ${expiresAt.toLocaleString()}`);
  console.log(`║  Hours:   ${hoursLeft}h remaining`);
  console.log('╠══════════════════════════════════════════════════╣');

  if (hoursLeft <= 0) {
    console.log('║  ⚠️  TOKEN EXPIRED — run "claude" to refresh     ║');
  } else if (hoursLeft < 2) {
    console.log('║  ⚠️  TOKEN EXPIRING SOON — consider refreshing   ║');
  } else {
    console.log('║  ✅ Token is valid                                ║');
  }

  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('# Copy-paste this into your .env file:');
  console.log(`CLAUDE_CODE_OAUTH_TOKEN=${oauth.accessToken}`);

} catch (err) {
  if (err.code === 'ENOENT') {
    console.error(`❌ Credentials file not found: ${CREDENTIALS_PATH}`);
    console.error('   Run "claude" in terminal first to authenticate.');
  } else {
    console.error('❌ Error reading credentials:', err.message);
  }
  process.exit(1);
}
