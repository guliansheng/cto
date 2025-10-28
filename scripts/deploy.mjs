import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CLOUDFLARE_API_TOKEN = 'sTmAGF_LUZBQVKcBIcxrAiOaUGgoySaStzcvhYhs';

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

function ensureApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return;
  }

  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const parsed = parseEnvFile(envPath);
    if (parsed.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN) {
      process.env.CLOUDFLARE_API_TOKEN = parsed.CLOUDFLARE_API_TOKEN;
    }
  }

  if (!process.env.CLOUDFLARE_API_TOKEN && DEFAULT_CLOUDFLARE_API_TOKEN) {
    process.env.CLOUDFLARE_API_TOKEN = DEFAULT_CLOUDFLARE_API_TOKEN;
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error(
      '\u274c  Missing CLOUDFLARE_API_TOKEN. Please set it as an environment variable or in a .env file.'
    );
    console.error('    You can create a token at https://developers.cloudflare.com/fundamentals/api/');
    process.exit(1);
  }
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
