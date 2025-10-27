import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

const SESSION_COOKIE = 'movie_api_session';
const ACCESS_PREFIX = 'access:';
const SESSION_PREFIX = 'session:';
const USER_PREFIX = 'user:';
const USER_INTERFACES_SUFFIX = ':interfaces';
const USER_PROFILE_SUFFIX = ':profile';
const PUBLIC_INTERFACES_KEY = 'public:interfaces';
const SHARE_PREFIX = 'share:';
const SHARE_BY_CODE_PREFIX = 'share-code:';

const DEFAULT_SESSION_TTL = 60 * 60 * 24; // 24 hours

type Role = 'admin' | 'user';

type InterfaceItem = {
  id: string;
  name: string;
  url: string;
  description: string;
  createdAt: number;
  createdBy: string;
};

type AccessCodeRecord = {
  code: string;
  createdAt: number;
  createdBy?: string;
  note?: string;
};

type UserProfile = {
  shareId: string;
  createdAt: number;
};

type SessionData = {
  token: string;
  code: string;
  role: Role;
  shareId: string;
  createdAt: number;
};

type Bindings = {
  MOVIE_API_DB: KVNamespace;
  ADMIN_CODE: string;
  SESSION_TTL_SECONDS?: string;
};

type AppVariables = {
  session?: SessionData;
};

type AppEnv = {
  Bindings: Bindings;
  Variables: AppVariables;
};

type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }
  c.header('Access-Control-Allow-Headers', 'Content-Type');
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  await next();
});

app.options('*', (c) => c.text('', 204));

app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  const bypass = path === '/api/login' || path === '/api/session' || path === '/api/logout';
  const session = await resolveSession(c);
  if (session) {
    c.set('session', session);
  }
  if (!session && !bypass) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  return next();
});

app.get('/', (c) => c.html(renderHtml()));

app.get('/u/:shareId', async (c) => {
  const shareId = c.req.param('shareId');
  const code = await c.env.MOVIE_API_DB.get(`${SHARE_PREFIX}${shareId}`);
  if (!code) {
    return c.json({ message: '未找到对应的接口配置' }, 404);
  }
  const interfaces = await getUserInterfaces(c.env, code);
  return c.json({
    urls: interfaces.map((item) => ({ name: item.name, url: item.url })),
  });
});

app.post('/api/login', async (c) => {
  const body = await safeJson(c);
  const rawCode = sanitizeText((body as Record<string, unknown>).code);
  if (!rawCode) {
    return c.json({ message: '请输入授权码' }, 400);
  }

  const adminCode = (c.env.ADMIN_CODE ?? '').trim();
  const isAdmin = Boolean(adminCode) && rawCode === adminCode;

  if (!isAdmin) {
    const record = await getAccessCodeRecord(c.env, rawCode);
    if (!record) {
      return c.json({ message: '授权码无效' }, 401);
    }
  }

  const shareId = await ensureShareId(c.env, rawCode);
  const session = await createSession(c, rawCode, isAdmin ? 'admin' : 'user', shareId);
  applySessionCookie(c, session);

  return c.json({
    user: { code: rawCode, role: session.role, shareId },
  });
});

app.post('/api/logout', async (c) => {
  const session = c.get('session');
  if (session) {
    await c.env.MOVIE_API_DB.delete(`${SESSION_PREFIX}${session.token}`);
  }
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get('/api/session', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ user: null });
  }
  const shareId = await ensureShareId(c.env, session.code);
  return c.json({
    user: {
      code: session.code,
      role: session.role,
      shareId,
    },
  });
});

app.get('/api/interfaces', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const targetCode = resolveTargetCode(c, session);
  const interfaces = await getUserInterfaces(c.env, targetCode);
  return c.json({ interfaces });
});

app.post('/api/interfaces', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const body = await safeJson(c);
  const payload = body as Record<string, unknown>;
  const name = sanitizeText(payload.name);
  const url = sanitizeText(payload.url);
  const description = sanitizeText(payload.description ?? '');
  const requestedCode = sanitizeText(payload.code ?? '');
  const targetCode = session.role === 'admin' && requestedCode ? requestedCode : session.code;

  if (!name || !url) {
    return c.json({ message: '接口名称和URL不能为空' }, 400);
  }

  const interfaces = await getUserInterfaces(c.env, targetCode);
  const newItem: InterfaceItem = {
    id: crypto.randomUUID(),
    name,
    url,
    description,
    createdAt: Date.now(),
    createdBy: session.code,
  };
  interfaces.push(newItem);
  await saveUserInterfaces(c.env, targetCode, interfaces);
  return c.json({ interface: newItem });
});

app.delete('/api/interfaces/:id', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const id = c.req.param('id');
  const requestedCode = sanitizeText(c.req.query('code') ?? '');
  const targetCode = session.role === 'admin' && requestedCode ? requestedCode : session.code;

  let interfaces = await getUserInterfaces(c.env, targetCode);
  const existing = interfaces.find((item) => item.id === id);
  if (!existing) {
    return c.json({ message: '接口不存在' }, 404);
  }
  if (session.role !== 'admin' && existing.createdBy !== session.code && targetCode !== session.code) {
    return c.json({ message: '没有权限删除此接口' }, 403);
  }
  interfaces = interfaces.filter((item) => item.id !== id);
  await saveUserInterfaces(c.env, targetCode, interfaces);
  return c.json({ ok: true });
});

app.get('/api/public-interfaces', async (c) => {
  const interfaces = await getPublicInterfaces(c.env);
  return c.json({ interfaces });
});

app.post('/api/public-interfaces', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const body = await safeJson(c);
  const payload = body as Record<string, unknown>;
  const name = sanitizeText(payload.name);
  const url = sanitizeText(payload.url);
  const description = sanitizeText(payload.description ?? '');

  if (!name || !url) {
    return c.json({ message: '接口名称和URL不能为空' }, 400);
  }

  const interfaces = await getPublicInterfaces(c.env);
  const newItem: InterfaceItem = {
    id: crypto.randomUUID(),
    name,
    url,
    description,
    createdAt: Date.now(),
    createdBy: session.code,
  };
  interfaces.push(newItem);
  await savePublicInterfaces(c.env, interfaces);
  return c.json({ interface: newItem });
});

app.delete('/api/public-interfaces/:id', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const id = c.req.param('id');
  const interfaces = await getPublicInterfaces(c.env);
  const item = interfaces.find((entry) => entry.id === id);
  if (!item) {
    return c.json({ message: '接口不存在' }, 404);
  }
  if (session.role !== 'admin' && item.createdBy !== session.code) {
    return c.json({ message: '没有权限删除此接口' }, 403);
  }
  const filtered = interfaces.filter((entry) => entry.id !== id);
  await savePublicInterfaces(c.env, filtered);
  return c.json({ ok: true });
});

app.get('/api/access-codes', ensureAdmin, async (c) => {
  const codes = await listAccessCodes(c.env);
  return c.json({ codes });
});

app.post('/api/access-codes', ensureAdmin, async (c) => {
  const session = c.get('session');
  const body = await safeJson(c);
  const payload = body as Record<string, unknown>;
  let code = sanitizeText(payload.code ?? '');
  const note = sanitizeText(payload.note ?? '');

  if (!code) {
    code = generateAccessCode();
  }

  const existing = await getAccessCodeRecord(c.env, code);
  if (existing) {
    return c.json({ message: '授权码已存在，请重新生成' }, 400);
  }

  const record: AccessCodeRecord = {
    code,
    createdAt: Date.now(),
    createdBy: session?.code,
    note,
  };
  await c.env.MOVIE_API_DB.put(`${ACCESS_PREFIX}${code}`, JSON.stringify(record));
  await ensureShareId(c.env, code);
  const codes = await listAccessCodes(c.env);
  return c.json({ codes });
});

app.delete('/api/access-codes/:code', ensureAdmin, async (c) => {
  const code = c.req.param('code');
  const shareId = await c.env.MOVIE_API_DB.get(`${SHARE_BY_CODE_PREFIX}${code}`);
  await c.env.MOVIE_API_DB.delete(`${ACCESS_PREFIX}${code}`);
  await c.env.MOVIE_API_DB.delete(`${USER_PREFIX}${code}${USER_INTERFACES_SUFFIX}`);
  await c.env.MOVIE_API_DB.delete(`${USER_PREFIX}${code}${USER_PROFILE_SUFFIX}`);
  if (shareId) {
    await c.env.MOVIE_API_DB.delete(`${SHARE_PREFIX}${shareId}`);
  }
  await c.env.MOVIE_API_DB.delete(`${SHARE_BY_CODE_PREFIX}${code}`);
  await revokeSessionsForUser(c.env, code);
  return c.json({ ok: true });
});

app.get('/api/address', async (c) => {
  const session = c.get('session');
  if (!session) {
    return c.json({ message: '未登录或会话已过期' }, 401);
  }
  const shareId = await ensureShareId(c.env, session.code);
  return c.json({ shareId });
});

app.get('/api/users', ensureAdmin, async (c) => {
  const codes = await listAccessCodes(c.env);
  const adminCode = (c.env.ADMIN_CODE ?? '').trim();
  const profiles = await Promise.all(
    codes.map(async (record) => {
      const shareId = await ensureShareId(c.env, record.code);
      const interfaceCount = (await getUserInterfaces(c.env, record.code)).length;
      return { ...record, shareId, interfaceCount, role: 'user' as Role };
    })
  );
  const adminEntry = adminCode
    ? [
        {
          code: adminCode,
          createdAt: 0,
          createdBy: 'system',
          note: '默认管理员',
          shareId: await ensureShareId(c.env, adminCode),
          interfaceCount: (await getUserInterfaces(c.env, adminCode)).length,
          role: 'admin' as Role,
        },
      ]
    : [];
  return c.json({ users: [...adminEntry, ...profiles] });
});

async function ensureAdmin(c: AppContext, next: Next) {
  const session = c.get('session');
  if (!session || session.role !== 'admin') {
    return c.json({ message: '仅管理员可访问' }, 403);
  }
  return next();
}

async function resolveSession(c: AppContext): Promise<SessionData | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const raw = await c.env.MOVIE_API_DB.get(`${SESSION_PREFIX}${token}`);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SessionData;
    return parsed;
  } catch (error) {
    return null;
  }
}

async function createSession(
  c: AppContext,
  code: string,
  role: Role,
  shareId: string
): Promise<SessionData> {
  const token = crypto.randomUUID();
  const ttl = parseInt(c.env.SESSION_TTL_SECONDS ?? '', 10) || DEFAULT_SESSION_TTL;
  const session: SessionData = { token, code, role, shareId, createdAt: Date.now() };
  await c.env.MOVIE_API_DB.put(`${SESSION_PREFIX}${token}`, JSON.stringify(session), {
    expirationTtl: ttl,
  });
  return session;
}

function applySessionCookie(c: AppContext, session: SessionData) {
  const ttl = parseInt(c.env.SESSION_TTL_SECONDS ?? '', 10) || DEFAULT_SESSION_TTL;
  const url = new URL(c.req.url);
  const secure = url.protocol === 'https:';
  setCookie(c, SESSION_COOKIE, session.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    secure,
    maxAge: ttl,
  });
}

function clearSessionCookie(c: AppContext) {
  const url = new URL(c.req.url);
  const secure = url.protocol === 'https:';
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure });
}

async function getUserInterfaces(env: Bindings, code: string): Promise<InterfaceItem[]> {
  const raw = await env.MOVIE_API_DB.get(`${USER_PREFIX}${code}${USER_INTERFACES_SUFFIX}`);
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as InterfaceItem[];
  } catch (error) {
    return [];
  }
}

async function saveUserInterfaces(env: Bindings, code: string, interfaces: InterfaceItem[]) {
  await env.MOVIE_API_DB.put(`${USER_PREFIX}${code}${USER_INTERFACES_SUFFIX}`, JSON.stringify(interfaces));
}

async function getPublicInterfaces(env: Bindings): Promise<InterfaceItem[]> {
  const raw = await env.MOVIE_API_DB.get(PUBLIC_INTERFACES_KEY);
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as InterfaceItem[];
  } catch (error) {
    return [];
  }
}

async function savePublicInterfaces(env: Bindings, interfaces: InterfaceItem[]) {
  await env.MOVIE_API_DB.put(PUBLIC_INTERFACES_KEY, JSON.stringify(interfaces));
}

async function getAccessCodeRecord(env: Bindings, code: string): Promise<AccessCodeRecord | null> {
  const raw = await env.MOVIE_API_DB.get(`${ACCESS_PREFIX}${code}`);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AccessCodeRecord;
  } catch (error) {
    return null;
  }
}

async function listAccessCodes(env: Bindings): Promise<AccessCodeRecord[]> {
  const list = await env.MOVIE_API_DB.list({ prefix: ACCESS_PREFIX });
  const items: AccessCodeRecord[] = [];
  for (const entry of list.keys) {
    const raw = await env.MOVIE_API_DB.get(entry.name);
    if (raw) {
      try {
        items.push(JSON.parse(raw) as AccessCodeRecord);
      } catch (error) {
        // ignore invalid record
      }
    }
  }
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return items;
}

async function ensureShareId(env: Bindings, code: string): Promise<string> {
  const profileKey = `${USER_PREFIX}${code}${USER_PROFILE_SUFFIX}`;
  const existing = await env.MOVIE_API_DB.get(profileKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as UserProfile;
      if (parsed.shareId) {
        await env.MOVIE_API_DB.put(`${SHARE_PREFIX}${parsed.shareId}`, code);
        await env.MOVIE_API_DB.put(`${SHARE_BY_CODE_PREFIX}${code}`, parsed.shareId);
        return parsed.shareId;
      }
    } catch (error) {
      // fall through to regenerate
    }
  }

  let shareId = generateShareId();
  // regenerate if collision exists
  while (await env.MOVIE_API_DB.get(`${SHARE_PREFIX}${shareId}`)) {
    shareId = generateShareId();
  }
  const profile: UserProfile = { shareId, createdAt: Date.now() };
  await env.MOVIE_API_DB.put(profileKey, JSON.stringify(profile));
  await env.MOVIE_API_DB.put(`${SHARE_PREFIX}${shareId}`, code);
  await env.MOVIE_API_DB.put(`${SHARE_BY_CODE_PREFIX}${code}`, shareId);
  return shareId;
}

async function revokeSessionsForUser(env: Bindings, code: string) {
  const list = await env.MOVIE_API_DB.list({ prefix: SESSION_PREFIX });
  for (const entry of list.keys) {
    const raw = await env.MOVIE_API_DB.get(entry.name);
    if (!raw) {
      continue;
    }
    try {
      const session = JSON.parse(raw) as SessionData;
      if (session.code === code) {
        await env.MOVIE_API_DB.delete(entry.name);
      }
    } catch (error) {
      // ignore invalid session
    }
  }
}

function generateShareId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function generateAccessCode(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
}

function sanitizeText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

async function safeJson(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body as Record<string, unknown>;
  } catch (error) {
    return {};
  }
}

function resolveTargetCode(c: AppContext, session: SessionData): string {
  const queryCode = c.req.query('code');
  if (session.role === 'admin' && queryCode) {
    return queryCode.trim();
  }
  return session.code;
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>影视仓接口管理系统</title>
  <style>
    :root {
      color-scheme: light dark;
      --primary: #5b67f1;
      --primary-dark: #3d49c1;
      --bg: #0f172a;
      --card-bg: rgba(15, 23, 42, 0.75);
      --border: rgba(148, 163, 184, 0.2);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --danger: #ef4444;
      --success: #22c55e;
      --shadow: 0 20px 40px rgba(15, 23, 42, 0.35);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      font-family: 'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(160deg, #0f172a 0%, #1e293b 50%, #312e81 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }
    .app-container {
      width: min(1100px, 100%);
      background: rgba(15, 23, 42, 0.85);
      border-radius: 24px;
      padding: 32px;
      backdrop-filter: blur(24px);
      box-shadow: var(--shadow);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .logo-area {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 32px;
    }
    .logo-area h1 {
      margin: 0;
      font-size: 1.8rem;
      font-weight: 700;
    }
    .tag {
      background: rgba(91, 103, 241, 0.12);
      color: var(--primary);
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.85rem;
    }
    .card {
      background: var(--card-bg);
      border-radius: 20px;
      padding: 24px;
      border: 1px solid var(--border);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .login-card {
      max-width: 420px;
      margin: 0 auto;
      text-align: center;
    }
    .login-card h2 {
      margin: 0 0 12px;
      font-size: 1.5rem;
    }
    .input-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
      text-align: left;
    }
    label {
      font-size: 0.95rem;
      color: var(--muted);
    }
    input, textarea, select {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(15, 23, 42, 0.6);
      color: var(--text);
      font-size: 1rem;
    }
    textarea {
      resize: vertical;
      min-height: 90px;
    }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 12px;
      padding: 12px 18px;
      font-size: 1rem;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.2s ease;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 12px 24px rgba(91, 103, 241, 0.25);
      background: var(--primary-dark);
    }
    button.danger {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(248, 113, 113, 0.4);
    }
    button.danger:hover {
      background: rgba(239, 68, 68, 0.35);
      box-shadow: 0 12px 24px rgba(239, 68, 68, 0.2);
    }
    .tabs {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
    }
    .tab {
      flex: 1;
      text-align: center;
      padding: 12px 16px;
      border-radius: 12px;
      background: rgba(148, 163, 184, 0.07);
      color: var(--muted);
      border: 1px solid transparent;
      cursor: pointer;
      font-weight: 500;
    }
    .tab.active {
      background: rgba(91, 103, 241, 0.15);
      color: #fff;
      border-color: rgba(91, 103, 241, 0.4);
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
    }
    .section-header h3 {
      margin: 0;
      font-size: 1.2rem;
    }
    .list {
      display: grid;
      gap: 16px;
    }
    .item {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      background: rgba(15, 23, 42, 0.6);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .item-title {
      font-size: 1.05rem;
      font-weight: 600;
    }
    .item-meta {
      color: var(--muted);
      font-size: 0.85rem;
      word-break: break-word;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .form-inline {
      display: grid;
      gap: 14px;
      margin-bottom: 24px;
    }
    .alert {
      padding: 12px 16px;
      border-radius: 12px;
      margin-bottom: 18px;
      background: rgba(34, 197, 94, 0.15);
      color: #86efac;
      border: 1px solid rgba(34, 197, 94, 0.35);
      font-size: 0.95rem;
    }
    .alert.error {
      background: rgba(239, 68, 68, 0.18);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.35);
    }
    .share-link {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border-radius: 12px;
      background: rgba(148, 163, 184, 0.08);
      border: 1px solid rgba(148, 163, 184, 0.18);
      margin-bottom: 20px;
    }
    .share-link label {
      font-size: 0.9rem;
      color: var(--muted);
    }
    .share-link-input {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .share-link-input input {
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 10px 14px;
      color: var(--text);
      flex: 1;
      min-width: 220px;
    }
    .share-link-input button {
      padding: 10px 16px;
      font-size: 0.95rem;
    }
    .share-inline {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .share-inline button {
      padding: 8px 14px;
      font-size: 0.9rem;
    }
    @media (max-width: 768px) {
      body {
        padding: 16px;
      }
      .app-container {
        padding: 20px;
      }
      .tabs {
        flex-direction: column;
      }
      .item-header {
        flex-direction: column;
        align-items: flex-start;
      }
      .actions {
        width: 100%;
        justify-content: flex-end;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <div class="logo-area">
      <span class="tag">影视仓接口管理</span>
      <h1>接口管理控制台</h1>
    </div>
    <div id="app-root"></div>
  </div>
  <script>
    const state = {
      user: null,
      interfaces: [],
      publicInterfaces: [],
      accessCodes: [],
      users: [],
      selectedUser: null,
      activeTab: 'interfaces',
      message: null,
      messageType: 'info'
    };

    const appRoot = document.getElementById('app-root');

    const apiFetch = async (url, options = {}) => {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        credentials: 'include'
      });
      if (!response.ok) {
        let message = '请求失败';
        try {
          const data = await response.json();
          message = data.message || message;
        } catch (error) {}
        throw new Error(message);
      }
      if (response.status === 204) return null;
      try {
        return await response.json();
      } catch (error) {
        return null;
      }
    };

    const setMessage = (message, type = 'info') => {
      state.message = message;
      state.messageType = type;
      render();
      if (message) {
        setTimeout(() => {
          if (state.message === message) {
            state.message = null;
            render();
          }
        }, 3200);
      }
    };

    const copyText = async (text) => {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setMessage('链接已复制');
      } catch (error) {
        setMessage('复制失败，请手动复制', 'error');
      }
    };

    const handleLogin = async (event) => {
      event.preventDefault();
      const code = event.target.code.value.trim();
      if (!code) {
        setMessage('请输入授权码', 'error');
        return;
      }
      try {
        const data = await apiFetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({ code })
        });
        state.user = data.user;
        setMessage('登录成功');
        if (state.user.role === 'admin') {
          await loadUsers();
        }
        await Promise.all([
          loadInterfaces(),
          loadPublicInterfaces(),
          state.user.role === 'admin' ? loadAccessCodes() : Promise.resolve()
        ]);
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleLogout = async () => {
      await apiFetch('/api/logout', { method: 'POST' });
      state.user = null;
      state.interfaces = [];
      state.publicInterfaces = [];
      state.accessCodes = [];
      state.users = [];
      state.selectedUser = null;
      setMessage('已退出登录');
      render();
    };

    const loadSession = async () => {
      try {
        const data = await apiFetch('/api/session');
        state.user = data?.user;
        if (state.user) {
          if (state.user.role === 'admin') {
            await loadUsers();
            await loadAccessCodes();
          }
          await Promise.all([
            loadInterfaces(),
            loadPublicInterfaces()
          ]);
        }
      } catch (error) {
        state.user = null;
      }
      render();
    };

    const loadInterfaces = async () => {
      if (!state.user) return;
      let params = '';
      if (state.user.role === 'admin') {
        const targetCode = state.selectedUser || state.user.code;
        state.selectedUser = targetCode;
        params = `?code=${encodeURIComponent(targetCode)}`;
      }
      const data = await apiFetch(`/api/interfaces${params}`);
      state.interfaces = data?.interfaces || [];
    };

    const loadPublicInterfaces = async () => {
      const data = await apiFetch('/api/public-interfaces');
      state.publicInterfaces = data?.interfaces || [];
    };

    const loadAccessCodes = async () => {
      const data = await apiFetch('/api/access-codes');
      state.accessCodes = data?.codes || [];
    };

    const loadUsers = async () => {
      const data = await apiFetch('/api/users');
      state.users = data?.users || [];
      if (!state.users.length) {
        state.selectedUser = state.user ? state.user.code : null;
      } else if (!state.selectedUser || !state.users.some((user) => user.code === state.selectedUser)) {
        state.selectedUser = state.users[0].code;
      }
    };

    const handleCreateInterface = async (event) => {
      event.preventDefault();
      const form = event.target;
      const payload = {
        name: form.name.value.trim(),
        url: form.url.value.trim(),
        description: form.description.value.trim()
      };
      if (state.user.role === 'admin' && state.selectedUser) {
        payload.code = state.selectedUser;
      }
      try {
        await apiFetch('/api/interfaces', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        form.reset();
        setMessage('接口已创建');
        await loadInterfaces();
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleDeleteInterface = async (id) => {
      try {
        const params = state.user.role === 'admin' && state.selectedUser
          ? `?code=${encodeURIComponent(state.selectedUser)}`
          : '';
        await apiFetch(`/api/interfaces/${id}${params}`, { method: 'DELETE' });
        setMessage('接口已删除');
        await loadInterfaces();
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleCreatePublicInterface = async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        await apiFetch('/api/public-interfaces', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.value.trim(),
            url: form.url.value.trim(),
            description: form.description.value.trim()
          })
        });
        form.reset();
        setMessage('接口广场条目已发布');
        await loadPublicInterfaces();
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleDeletePublicInterface = async (id) => {
      try {
        await apiFetch(`/api/public-interfaces/${id}`, { method: 'DELETE' });
        setMessage('接口广场条目已删除');
        await loadPublicInterfaces();
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleCreateAccessCode = async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        await apiFetch('/api/access-codes', {
          method: 'POST',
          body: JSON.stringify({
            code: form.code.value.trim(),
            note: form.note.value.trim()
          })
        });
        form.reset();
        setMessage('访问码已创建');
        await Promise.all([loadAccessCodes(), loadUsers(), loadInterfaces()]);
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleDeleteAccessCode = async (code) => {
      if (!confirm('确认删除该访问码？')) return;
      try {
        await apiFetch(`/api/access-codes/${code}`, { method: 'DELETE' });
        setMessage('访问码已删除');
        await Promise.all([loadAccessCodes(), loadUsers(), loadInterfaces()]);
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    };

    const handleCopyShareLink = async () => {
      const input = document.getElementById('share-link-input');
      if (!input) return;
      await copyText(input.value);
    };

    const renderLogin = () => `
      <div class="card login-card">
        <h2>授权码登录</h2>
        <p class="item-meta">请输入管理员提供的授权码以访问系统</p>
        <form onsubmit="return false" id="login-form" class="form-inline">
          <div class="input-group">
            <label for="code">授权码</label>
            <input id="code" name="code" placeholder="请输入授权码" />
          </div>
          <button type="submit">登录系统</button>
        </form>
      </div>
    `;

    const renderInterfaceList = () => {
      if (!state.interfaces.length) {
        return '<p class="item-meta">暂无接口，请先创建。</p>';
      }
      return state.interfaces.map((item) => `
        <div class="item">
          <div class="item-header">
            <div>
              <div class="item-title">${item.name}</div>
              <div class="item-meta">${item.url}</div>
            </div>
            <div class="actions">
              <button class="danger" data-action="delete-interface" data-id="${item.id}">删除</button>
            </div>
          </div>
          ${item.description ? `<div class="item-meta">${item.description}</div>` : ''}
        </div>
      `).join('');
    };

    const renderPublicList = () => {
      if (!state.publicInterfaces.length) {
        return '<p class="item-meta">接口广场暂无内容，快来发布吧。</p>';
      }
      return state.publicInterfaces.map((item) => {
        const canDelete = state.user.role === 'admin' || item.createdBy === state.user.code;
        return `
          <div class="item">
            <div class="item-header">
              <div>
                <div class="item-title">${item.name}</div>
                <div class="item-meta">${item.url}</div>
              </div>
              ${canDelete ? `<div class="actions"><button class="danger" data-action="delete-public" data-id="${item.id}">删除</button></div>` : ''}
            </div>
            ${item.description ? `<div class="item-meta">${item.description}</div>` : ''}
            <div class="item-meta">发布者：${item.createdBy}</div>
          </div>
        `;
      }).join('');
    };

    const renderAccessCodes = () => {
      if (!state.accessCodes.length) {
        return '<p class="item-meta">暂无访问码</p>';
      }
      return state.accessCodes.map((item) => {
        const owner = state.users.find((user) => user.code === item.code);
        const shareLink = owner ? `${window.location.origin}/u/${owner.shareId}` : '';
        return `
          <div class="item">
            <div class="item-header">
              <div>
                <div class="item-title">${item.code}</div>
                <div class="item-meta">创建时间：${new Date(item.createdAt).toLocaleString()}</div>
              </div>
              <div class="actions">
                <button class="danger" data-action="delete-access" data-code="${item.code}">删除</button>
              </div>
            </div>
            ${item.note ? `<div class="item-meta">备注：${item.note}</div>` : ''}
            ${shareLink ? `<div class="share-inline"><span class="item-meta">访问地址：${shareLink}</span><button data-action="copy-link" data-link="${shareLink}">复制</button></div>` : ''}
          </div>
        `;
      }).join('');
    };

    const renderUsersSelect = () => {
      if (!state.users.length || state.user.role !== 'admin') {
        return '';
      }
      return `
        <div class="input-group">
          <label>选择用户以管理接口</label>
          <select id="user-selector">
            ${state.users.map((user) => `
              <option value="${user.code}" ${state.selectedUser === user.code ? 'selected' : ''}>
                ${user.code}${user.role === 'admin' ? '（管理员）' : `（接口 ${user.interfaceCount} 个）`}
              </option>
            `).join('')}
          </select>
        </div>
      `;
    };

    const renderDashboard = () => {
      const shareOwner = state.user.role === 'admin'
        ? state.users.find((user) => user.code === state.selectedUser) || state.user
        : state.user;
      const shareLink = shareOwner ? `${window.location.origin}/u/${shareOwner.shareId}` : '';
      const shareLabel = state.user.role === 'admin'
        ? `接口访问地址（${shareOwner.code}）`
        : '接口访问地址';

      return `
        <div class="card">
          <div class="section-header">
            <h3>欢迎，${state.user.code}</h3>
            <button id="logout-btn">退出</button>
          </div>
          <div class="share-link">
            <label>${shareLabel}</label>
            <div class="share-link-input">
              <input id="share-link-input" value="${shareLink}" readonly />
              <button id="copy-share">复制</button>
            </div>
          </div>
          <div class="tabs">
            <div class="tab ${state.activeTab === 'interfaces' ? 'active' : ''}" data-tab="interfaces">接口管理</div>
            <div class="tab ${state.activeTab === 'public' ? 'active' : ''}" data-tab="public">接口广场</div>
            ${state.user.role === 'admin' ? `<div class="tab ${state.activeTab === 'codes' ? 'active' : ''}" data-tab="codes">访问码管理</div>` : ''}
          </div>
          ${state.message ? `<div class="alert ${state.messageType === 'error' ? 'error' : ''}">${state.message}</div>` : ''}
          ${state.activeTab === 'interfaces' ? `
            ${renderUsersSelect()}
            <form id="create-interface" class="form-inline">
              <div class="input-group">
                <label>接口名称</label>
                <input name="name" placeholder="例如：影视仓线路一" required />
              </div>
              <div class="input-group">
                <label>接口地址</label>
                <input name="url" placeholder="https://example.com/api.json" required />
              </div>
              <div class="input-group">
                <label>接口描述</label>
                <textarea name="description" placeholder="可选描述信息"></textarea>
              </div>
              <button type="submit">创建接口</button>
            </form>
            <div class="list" id="interface-list">${renderInterfaceList()}</div>
          ` : ''}
          ${state.activeTab === 'public' ? `
            <form id="create-public" class="form-inline">
              <div class="input-group">
                <label>接口名称</label>
                <input name="name" placeholder="请输入名称" required />
              </div>
              <div class="input-group">
                <label>接口地址</label>
                <input name="url" placeholder="https://example.com/api.json" required />
              </div>
              <div class="input-group">
                <label>接口描述</label>
                <textarea name="description" placeholder="接口特点或说明"></textarea>
              </div>
              <button type="submit">发布到接口广场</button>
            </form>
            <div class="list" id="public-list">${renderPublicList()}</div>
          ` : ''}
          ${state.activeTab === 'codes' ? `
            <form id="create-access" class="form-inline">
              <div class="input-group">
                <label>访问码（留空将自动生成）</label>
                <input name="code" placeholder="例如：VIPUSER01" />
              </div>
              <div class="input-group">
                <label>备注</label>
                <input name="note" placeholder="例如：影迷交流群" />
              </div>
              <button type="submit">创建访问码</button>
            </form>
            <div class="list" id="access-list">${renderAccessCodes()}</div>
          ` : ''}
        </div>
      `;
    };

    const render = () => {
      if (!state.user) {
        appRoot.innerHTML = renderLogin();
        const form = document.getElementById('login-form');
        form.addEventListener('submit', handleLogin);
        return;
      }
      appRoot.innerHTML = renderDashboard();
      document.getElementById('logout-btn').addEventListener('click', handleLogout);
      document.getElementById('copy-share').addEventListener('click', handleCopyShareLink);
      document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', async () => {
          state.activeTab = tab.dataset.tab;
          if (state.activeTab === 'public') {
            await loadPublicInterfaces();
          } else if (state.activeTab === 'codes') {
            await Promise.all([loadAccessCodes(), loadUsers()]);
          } else if (state.activeTab === 'interfaces') {
            await loadInterfaces();
          }
          render();
        });
      });
      const createInterfaceForm = document.getElementById('create-interface');
      if (createInterfaceForm) {
        createInterfaceForm.addEventListener('submit', handleCreateInterface);
      }
      const createPublicForm = document.getElementById('create-public');
      if (createPublicForm) {
        createPublicForm.addEventListener('submit', handleCreatePublicInterface);
      }
      const createAccessForm = document.getElementById('create-access');
      if (createAccessForm) {
        createAccessForm.addEventListener('submit', handleCreateAccessCode);
      }
      document.querySelectorAll('[data-action="delete-interface"]').forEach((btn) => {
        btn.addEventListener('click', () => handleDeleteInterface(btn.dataset.id));
      });
      document.querySelectorAll('[data-action="delete-public"]').forEach((btn) => {
        btn.addEventListener('click', () => handleDeletePublicInterface(btn.dataset.id));
      });
      document.querySelectorAll('[data-action="delete-access"]').forEach((btn) => {
        btn.addEventListener('click', () => handleDeleteAccessCode(btn.dataset.code));
      });
      document.querySelectorAll('[data-action="copy-link"]').forEach((btn) => {
        btn.addEventListener('click', () => copyText(btn.dataset.link));
      });
      const selector = document.getElementById('user-selector');
      if (selector) {
        selector.addEventListener('change', async (event) => {
          state.selectedUser = event.target.value;
          await loadInterfaces();
          render();
        });
      }
    };

    loadSession();
  </script>
</body>
</html>`;
}

export default app;
