#!/usr/bin/env node

/**
 * find-claude-token.mjs
 * 
 * Detective script to find Claude Code OAuth token
 * regardless of cc version or storage method.
 * 
 * Checks:
 *   1. ~/.claude/.credentials.json (legacy)
 *   2. ~/.claude/config.json
 *   3. ~/.claude/settings.json
 *   4. ~/.claude/settings.local.json
 *   5. All .json files in ~/.claude/ for token-like values
 *   6. macOS Keychain (security command)
 *   7. Environment variables
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const CLAUDE_DIR = join(homedir(), '.claude');
const FOUND = [];

// ── Helpers ──────────────────────────────────────────────

function mask(token) {
  if (!token || token.length < 20) return token;
  return token.slice(0, 12) + '...' + token.slice(-6);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

function searchObject(obj, path = '') {
  const hits = [];
  if (!obj || typeof obj !== 'object') return hits;
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    
    if (typeof value === 'string') {
      // Look for OAuth tokens, API keys, bearer tokens
      const isToken = 
        /token/i.test(key) ||
        /oauth/i.test(key) ||
        /api.?key/i.test(key) ||
        /bearer/i.test(key) ||
        /credential/i.test(key) ||
        /secret/i.test(key) ||
        /auth/i.test(key) ||
        // Value patterns
        value.startsWith('sk-ant-') ||
        value.startsWith('eyJ') ||  // JWT
        (value.length > 50 && /^[A-Za-z0-9_-]+$/.test(value));
      
      if (isToken) {
        hits.push({ path: currentPath, value, length: value.length });
      }
    } else if (typeof value === 'object' && value !== null) {
      hits.push(...searchObject(value, currentPath));
    }
  }
  return hits;
}

function report(source, tokens) {
  for (const t of tokens) {
    console.log(`  ✅ ${source} → ${t.path}`);
    console.log(`     Value: ${mask(t.value)} (${t.length} chars)`);
    FOUND.push({ source, ...t });
  }
}

// ── Checks ───────────────────────────────────────────────

console.log('\n🔍 Claude Code Token Detective\n');
console.log(`📁 Claude dir: ${CLAUDE_DIR}\n`);

// 1. Check env vars
console.log('── 1. Environment variables ──');
const envVars = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY', 
  'CLAUDE_API_KEY',
  'CLAUDE_AUTH_TOKEN'
];
for (const name of envVars) {
  if (process.env[name]) {
    console.log(`  ✅ $${name} = ${mask(process.env[name])}`);
    FOUND.push({ source: 'env', path: name, value: process.env[name] });
  } else {
    console.log(`  ❌ $${name} not set`);
  }
}

// 2. Known JSON files
console.log('\n── 2. Known config files ──');
const knownFiles = [
  '.credentials.json',
  'credentials.json',
  'config.json',
  'settings.json',
  'settings.local.json',
];

for (const file of knownFiles) {
  const fullPath = join(CLAUDE_DIR, file);
  const data = await readJson(fullPath);
  if (data) {
    const tokens = searchObject(data);
    if (tokens.length > 0) {
      report(file, tokens);
    } else {
      console.log(`  📄 ${file} exists but no token-like values found`);
    }
  } else {
    console.log(`  ❌ ${file} not found`);
  }
}

// 3. Scan ALL json files in ~/.claude/
console.log('\n── 3. Deep scan all .json files ──');
try {
  const entries = await readdir(CLAUDE_DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.json') && !knownFiles.includes(e.name))
    .map(e => e.name);
  
  for (const file of jsonFiles) {
    const data = await readJson(join(CLAUDE_DIR, file));
    if (data) {
      const tokens = searchObject(data);
      if (tokens.length > 0) {
        report(file, tokens);
      } else {
        console.log(`  📄 ${file} — no tokens`);
      }
    }
  }
  if (jsonFiles.length === 0) {
    console.log('  (no additional json files)');
  }
} catch (err) {
  console.log(`  ❌ Error scanning: ${err.message}`);
}

// 4. Check subdirectories for credential files
console.log('\n── 4. Subdirectory scan ──');
try {
  const entries = await readdir(CLAUDE_DIR, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  
  for (const dir of dirs) {
    const dirPath = join(CLAUDE_DIR, dir);
    try {
      const subEntries = await readdir(dirPath);
      const credFiles = subEntries.filter(f => 
        /credential|token|auth|oauth|secret/i.test(f) ||
        f.endsWith('.json')
      );
      
      for (const file of credFiles.slice(0, 5)) { // limit per dir
        const data = await readJson(join(dirPath, file));
        if (data) {
          const tokens = searchObject(data);
          if (tokens.length > 0) {
            report(`${dir}/${file}`, tokens);
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
} catch (err) {
  console.log(`  ❌ Error: ${err.message}`);
}

// 5. macOS Keychain
console.log('\n── 5. macOS Keychain ──');
if (process.platform === 'darwin') {
  const keychainSearches = [
    'claude',
    'claude-code', 
    'anthropic',
    'claude.ai',
    'api.anthropic.com',
  ];
  
  for (const service of keychainSearches) {
    try {
      const result = execSync(
        `security find-generic-password -s "${service}" -w 2>/dev/null`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim();
      if (result) {
        console.log(`  ✅ Keychain service="${service}" → ${mask(result)}`);
        FOUND.push({ source: 'keychain', path: service, value: result });
      }
    } catch {
      // Not found, try internet passwords too
      try {
        const result = execSync(
          `security find-internet-password -s "${service}" -w 2>/dev/null`,
          { encoding: 'utf-8', timeout: 3000 }
        ).trim();
        if (result) {
          console.log(`  ✅ Keychain internet-password "${service}" → ${mask(result)}`);
          FOUND.push({ source: 'keychain', path: service, value: result });
        }
      } catch { /* not found */ }
    }
  }
  
  // Broader keychain dump search
  try {
    const dump = execSync(
      'security dump-keychain 2>/dev/null | grep -i "claude\\|anthropic" | head -20',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (dump) {
      console.log('  🔑 Keychain entries containing "claude" or "anthropic":');
      console.log(dump.split('\n').map(l => `     ${l.trim()}`).join('\n'));
    } else {
      console.log('  ❌ No claude/anthropic entries in keychain');
    }
  } catch {
    console.log('  ❌ Could not search keychain dump');
  }
} else {
  console.log('  ⏭️  Not macOS, skipping keychain');
}

// 6. Check ~/.config alternatives
console.log('\n── 6. Alternative config locations ──');
const altPaths = [
  join(homedir(), '.config', 'claude'),
  join(homedir(), '.config', 'claude-code'),
  join(homedir(), '.config', 'anthropic'),
];
for (const altPath of altPaths) {
  try {
    const entries = await readdir(altPath);
    console.log(`  📁 ${altPath}: ${entries.join(', ')}`);
    for (const file of entries.filter(f => f.endsWith('.json'))) {
      const data = await readJson(join(altPath, file));
      if (data) {
        const tokens = searchObject(data);
        if (tokens.length > 0) report(`${altPath}/${file}`, tokens);
      }
    }
  } catch {
    console.log(`  ❌ ${altPath} not found`);
  }
}

// ── Summary ──────────────────────────────────────────────

console.log('\n' + '═'.repeat(50));
if (FOUND.length > 0) {
  console.log(`\n🎯 Found ${FOUND.length} token(s):\n`);
  for (const t of FOUND) {
    console.log(`   ${t.source} → ${t.path}`);
    console.log(`   ${mask(t.value)} (${t.value.length} chars)\n`);
  }
  
  // Identify the best candidate
  const best = FOUND.find(t => t.value.startsWith('sk-ant-')) 
    || FOUND.find(t => t.value.startsWith('eyJ'))
    || FOUND.find(t => t.value.length > 100)
    || FOUND[0];
  
  console.log(`💡 Best candidate for Docker injection:`);
  console.log(`   Source: ${best.source} → ${best.path}`);
  console.log(`   Export: CLAUDE_CODE_OAUTH_TOKEN="${mask(best.value)}"`);
} else {
  console.log('\n❌ No tokens found anywhere!\n');
  console.log('   Possible reasons:');
  console.log('   • Claude Code uses interactive browser auth (no stored token)');
  console.log('   • Token stored in a system-level credential manager');
  console.log('   • Claude Max plan uses session cookies, not API tokens');
  console.log('');
  console.log('   Try running: claude auth status');
  console.log('   Or check:    claude config list');
}
console.log('');
