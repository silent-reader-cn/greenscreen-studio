/**
 * WebUI 访问密码认证（2026-08-10）
 *
 * 设计：
 * - 配置存 data/webui-config.json（{ enabled, salt, passwordHash, secret }），gitignored，不落库
 * - 密码 scrypt 哈希存储，绝不明文
 * - 登录成功签发 HMAC-SHA256 无状态 token（默认 7 天有效），重启服务不失效
 * - 环境变量：
 *   - GSS_WEBUI_AUTH_DISABLED=1  → 完全禁用认证（Electron 桌面壳 fork 时传入，永不弹密码）
 *   - GSS_WEBUI_PASSWORD=xxx     → 强制启用并用该密码（部署注入用，不写配置文件，优先于配置文件）
 * - 中间件白名单：/api/auth/*、/api/health（NSSM 健康检查），其余 /api/* 均需 Bearer token
 * - 静态资源不拦（SPA 登录页由前端渲染，数据全走 /api）
 *
 * PATCH /api/auth/config 规则：
 *   - 当前未启用 → 允许匿名开启（首次初始化，必须提供 password ≥ 4 字符）
 *   - 当前已启用 → 需有效 token；关闭需 currentPassword；改密码需 currentPassword + password
 *   - GSS_WEBUI_PASSWORD 存在时拒绝修改（环境变量优先）
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { getDataDir } = require('./paths.cjs');

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天
const MIN_PASSWORD_LEN = 4;

let _configCache = null;

function getConfigPath() {
  return path.join(getDataDir(), 'webui-config.json');
}

function readConfig() {
  if (_configCache) return _configCache;
  const p = getConfigPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    _configCache = JSON.parse(raw);
  } catch {
    _configCache = {};
  }
  return _configCache;
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  _configCache = cfg;
  return cfg;
}

/** 测试专用：清空模块内配置缓存（配合删除配置文件使用） */
function _resetForTest() {
  _configCache = null;
}

function getEnvPassword() {
  return process.env.GSS_WEBUI_PASSWORD || null;
}

function isDisabledByEnv() {
  return process.env.GSS_WEBUI_AUTH_DISABLED === '1';
}

/** 实际生效的启用状态（env 优先于配置文件） */
function isEnabled() {
  if (isDisabledByEnv()) return false;
  if (getEnvPassword()) return true;
  return !!readConfig().enabled;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = hashPassword(password, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  if (expected.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expected, actualBuf);
}

function getSecret() {
  const cfg = readConfig();
  if (cfg.secret) return cfg.secret;
  const secret = crypto.randomBytes(32).toString('hex');
  writeConfig({ secret });
  return secret;
}

/** 签发 token：base64url(payload).base64url(hmac) */
function signToken() {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    exp: Date.now() + TOKEN_TTL_MS,
    jti: crypto.randomUUID(),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** 验证 token，合法返回 payload，否则 null */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

/** 从请求头提取 token */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/** 认证中间件：挂在 app.use('/api', ...) 下，拦截除白名单外的所有 API */
function middleware(req, res, next) {
  // req.path 在 app.use('/api', mw) 挂载点下不含 /api 前缀
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  if (!isEnabled()) return next();
  const token = extractToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'unauthorized', code: 'AUTH_REQUIRED' });
  }
  req.webuiAuth = payload;
  next();
}

function router() {
  const r = express.Router();

  // GET /api/auth/status → { enabled, authenticated }
  r.get('/status', (req, res) => {
    const token = extractToken(req);
    res.json({
      enabled: isEnabled(),
      authenticated: !!verifyToken(token),
    });
  });

  // POST /api/auth/login { password } → { token }
  r.post('/login', (req, res) => {
    if (!isEnabled()) {
      return res.status(400).json({ error: 'auth disabled', code: 'AUTH_DISABLED' });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string') {
      return res.status(400).json({ error: 'password required', code: 'BAD_REQUEST' });
    }
    const envPw = getEnvPassword();
    const ok = envPw
      ? crypto.timingSafeEqual(Buffer.from(String(envPw)), Buffer.from(password))
      : verifyPassword(password, readConfig().salt, readConfig().passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'invalid password', code: 'BAD_CREDENTIALS' });
    }
    res.json({ token: signToken() });
  });

  // GET /api/auth/config → { enabled }（设置面板显示用，需认证；未启用时也允许查）
  r.get('/config', (req, res) => {
    if (isEnabled() && !verifyToken(extractToken(req))) {
      return res.status(401).json({ error: 'unauthorized', code: 'AUTH_REQUIRED' });
    }
    res.json({ enabled: isEnabled() });
  });

  // PATCH /api/auth/config { enabled, password?, currentPassword? }
  r.patch('/config', (req, res) => {
    if (getEnvPassword()) {
      return res.status(403).json({ error: 'password controlled by env', code: 'ENV_CONTROLLED' });
    }
    const cfg = readConfig();
    const currentlyEnabled = !!cfg.enabled;
    const { enabled, password, currentPassword } = req.body || {};

    if (currentlyEnabled) {
      // 已启用：需有效 token
      if (!verifyToken(extractToken(req))) {
        return res.status(401).json({ error: 'unauthorized', code: 'AUTH_REQUIRED' });
      }
      const currentOk = verifyPassword(currentPassword || '', cfg.salt, cfg.passwordHash);
      if (!currentOk) {
        return res.status(400).json({ error: 'current password required', code: 'CURRENT_PASSWORD_REQUIRED' });
      }
      if (enabled === false) {
        writeConfig({ enabled: false });
        return res.json({ enabled: false });
      }
      // 保持启用：改密码
      if (typeof password === 'string' && password.length >= MIN_PASSWORD_LEN) {
        const salt = crypto.randomBytes(16).toString('hex');
        writeConfig({ enabled: true, salt, passwordHash: hashPassword(password, salt) });
        return res.json({ enabled: true });
      }
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} chars`, code: 'PASSWORD_TOO_SHORT' });
    }

    // 未启用：允许匿名开启（首次初始化）
    if (enabled === false) {
      return res.json({ enabled: false });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} chars`, code: 'PASSWORD_TOO_SHORT' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    writeConfig({ enabled: true, salt, passwordHash: hashPassword(password, salt) });
    res.json({ enabled: true });
  });

  return r;
}

module.exports = {
  middleware,
  router,
  isEnabled,
  isDisabledByEnv,
  readConfig,
  writeConfig,
  verifyToken,
  signToken,
  hashPassword,
  verifyPassword,
  _resetForTest,
  TOKEN_TTL_MS,
  MIN_PASSWORD_LEN,
};
