import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CLOUDFLARE_API_TOKEN = 'sTmAGF_LUZBQVKcBIcxrAiOaUGgoySaStzcvhYhs';
const API_TOKEN_ENV_KEYS = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'];
const API_TOKEN_FILE_ENV_KEYS = ['CLOUDFLARE_API_TOKEN_FILE', 'CF_API_TOKEN_FILE'];

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readTokenFromFile(path) {
  try {
    if (!isNonEmptyString(path)) {
      return null;
    }
    const resolvedPath = resolve(path.trim());
    if (!existsSync(resolvedPath)) {
      return null;
    }
    const content = readFileSync(resolvedPath, 'utf8').trim();
    return isNonEmptyString(content) ? content : null;
  } catch (error) {
    console.warn(`⚠️  Failed to read API token from file "${path}": ${error.message}`);
    return null;
  }
}

function resolveApiTokenFromEnvironment() {
  for (const key of API_TOKEN_ENV_KEYS) {
    const value = process.env[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  for (const key of API_TOKEN_FILE_ENV_KEYS) {
    const filePath = process.env[key];
    const value = readTokenFromFile(filePath);
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }

  return null;
}

function resolveApiTokenFromDotEnv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return null;
  }
  const parsed = parseEnvFile(envPath);
  for (const key of API_TOKEN_ENV_KEYS) {
    const value = parsed[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return null;
}

function resolveApiToken() {
  const fromEnv = resolveApiTokenFromEnvironment();
  if (isNonEmptyString(fromEnv)) {
    return fromEnv;
  }

  const fromDotEnv = resolveApiTokenFromDotEnv();
  if (isNonEmptyString(fromDotEnv)) {
    return fromDotEnv;
  }

  if (isNonEmptyString(DEFAULT_CLOUDFLARE_API_TOKEN)) {
    return DEFAULT_CLOUDFLARE_API_TOKEN.trim();
  }

  return null;
}

function ensureApiToken() {
  const token = resolveApiToken();
  if (isNonEmptyString(token)) {
    process.env.CLOUDFLARE_API_TOKEN = token;
    process.env.CF_API_TOKEN = token;
    return;
  }

  console.error(
    '❌  Missing CLOUDFLARE_API_TOKEN. Please set it as an environment variable, in a .env file, or provide a *_FILE variant.'
  );
  console.error('    You can create a token at https://developers.cloudflare.com/fundamentals/api/');
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

ensureApiToken();
runWranglerDeploy();
