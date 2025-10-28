import { spawn } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const API_TOKEN_ENV_KEYS = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'];
const API_TOKEN_FILE_ENV_KEYS = ['CLOUDFLARE_API_TOKEN_FILE', 'CF_API_TOKEN_FILE'];
const API_KEY_ENV_KEYS = ['CLOUDFLARE_API_KEY', 'CF_API_KEY'];
const EMAIL_ENV_KEYS = ['CLOUDFLARE_EMAIL', 'CF_EMAIL'];

let cachedDotEnv = null;
let hasLoadedDotEnv = false;

function parseEnvFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const cleaned = rawValue.replace(/^['"]|['"]$/g, '');
    result[key] = cleaned;
  }
  return result;
}

function ensureDotEnvLoaded() {
  if (hasLoadedDotEnv) {
    return cachedDotEnv;
  }
  hasLoadedDotEnv = true;
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    cachedDotEnv = null;
    return cachedDotEnv;
  }
  cachedDotEnv = parseEnvFile(envPath);
  return cachedDotEnv;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePath(input) {
  if (!isNonEmptyString(input)) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

function collectWranglerConfigCandidates() {
  const candidates = new Set();

  const explicit = normalizePath(process.env.WRANGLER_CONFIG_PATH);
  if (explicit) {
    candidates.add(explicit);
  }

  const homes = new Set();
  const customHome = normalizePath(process.env.WRANGLER_HOME);
  if (customHome) {
    homes.add(customHome);
  }
  homes.add(resolve(process.cwd(), '.wrangler'));
  homes.add(resolve(homedir(), '.wrangler'));

  for (const base of homes) {
    candidates.add(resolve(base, 'default.toml'));
    candidates.add(resolve(base, 'config', 'default.toml'));
  }

  return Array.from(candidates);
}

function hasPersistentWranglerLogin() {
  for (const candidate of collectWranglerConfigCandidates()) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      const stats = statSync(candidate);
      if (stats.isFile()) {
        return true;
      }
    } catch (error) {
      // ignore and continue checking the rest of the candidates
    }
  }
  return false;
}

function readTokenFromFile(path) {
  try {
    if (!isNonEmptyString(path)) {
      return null;
    }
    const resolvedPath = normalizePath(path);
    if (!resolvedPath || !existsSync(resolvedPath)) {
      return null;
    }
    const content = readFileSync(resolvedPath, 'utf8').trim();
    return isNonEmptyString(content) ? content : null;
  } catch (error) {
    console.warn(`⚠️  Failed to read API token from file "${path}": ${error.message}`);
    return null;
  }
}

function getEnvValue(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return null;
}

function getDotEnvValue(keys) {
  const parsed = ensureDotEnvLoaded();
  if (!parsed) {
    return null;
  }
  for (const key of keys) {
    const value = parsed[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return null;
}

function resolveFileCredential(keys) {
  const direct = readTokenFromFile(getEnvValue(keys));
  if (isNonEmptyString(direct)) {
    return direct.trim();
  }
  const fromDotEnv = readTokenFromFile(getDotEnvValue(keys));
  return isNonEmptyString(fromDotEnv) ? fromDotEnv.trim() : null;
}

function resolveCredential(keys) {
  const fromEnv = getEnvValue(keys);
  if (isNonEmptyString(fromEnv)) {
    return fromEnv;
  }
  const fromDotEnv = getDotEnvValue(keys);
  return isNonEmptyString(fromDotEnv) ? fromDotEnv : null;
}

function resolveApiToken() {
  const token = resolveCredential(API_TOKEN_ENV_KEYS);
  if (isNonEmptyString(token)) {
    return token;
  }
  const fileToken = resolveFileCredential(API_TOKEN_FILE_ENV_KEYS);
  if (isNonEmptyString(fileToken)) {
    return fileToken;
  }
  return null;
}

function resolveApiKeyCredentials() {
  const apiKey = resolveCredential(API_KEY_ENV_KEYS);
  const email = resolveCredential(EMAIL_ENV_KEYS);
  if (isNonEmptyString(apiKey) && isNonEmptyString(email)) {
    return {
      apiKey: apiKey.trim(),
      email: email.trim(),
    };
  }
  return null;
}

function ensureApiCredentials() {
  const token = resolveApiToken();
  if (isNonEmptyString(token)) {
    process.env.CLOUDFLARE_API_TOKEN = token;
    process.env.CF_API_TOKEN = token;
    return;
  }

  const apiKeyCredentials = resolveApiKeyCredentials();
  if (apiKeyCredentials) {
    const { apiKey, email } = apiKeyCredentials;
    process.env.CLOUDFLARE_API_KEY = apiKey;
    process.env.CF_API_KEY = apiKey;
    process.env.CLOUDFLARE_EMAIL = email;
    process.env.CF_EMAIL = email;
    return;
  }

  if (hasPersistentWranglerLogin()) {
    console.log('ℹ️  Using existing Wrangler authentication from wrangler login.');
    return;
  }

  console.error(
    '❌  Missing Cloudflare credentials. Provide either a CLOUDFLARE_API_TOKEN/CF_API_TOKEN (or *_FILE variant) or both CLOUDFLARE_API_KEY/CF_API_KEY and CLOUDFLARE_EMAIL/CF_EMAIL.'
  );
  console.error('    Refer to https://developers.cloudflare.com/workers/wrangler/authentication/ for supported options.');
  process.exit(1);
}

function runWranglerDeploy() {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const child = spawn(command, ['wrangler', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`Failed to run wrangler deploy: ${error.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

ensureApiCredentials();
runWranglerDeploy();
