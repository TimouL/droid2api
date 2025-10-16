import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { logInfo, logError, logDebug } from './logger.js';
import { isServerAuthEnabled } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_FILE = path.join(__dirname, 'server-key.json');
const ENV_KEY_NAME = 'SERVER_AUTH_KEY';
const STATUS_COOKIE_NAME = 'status_auth';
const STATUS_COOKIE_MAX_AGE = 60 * 60 * 12; // 12 hours

let cachedKey = null;

/**
 * Load server key from environment variable
 * Priority: ENV > Cached > Disk
 */
function loadKeyFromEnv() {
  const envKey = process.env[ENV_KEY_NAME];
  if (envKey && typeof envKey === 'string' && envKey.trim() !== '') {
    return envKey.trim();
  }
  return null;
}

function loadKeyFromDisk() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data.key === 'string' && data.key.trim() !== '') {
        cachedKey = data.key.trim();
        return cachedKey;
      }
    }
  } catch (err) {
    logError('Failed to read server key from disk', err);
  }
  return null;
}

function getServerKeyValue() {
  const envKey = loadKeyFromEnv();
  if (envKey && envKey.length > 0) {
    return envKey;
  }

  if (cachedKey && cachedKey.length > 0) {
    return cachedKey;
  }

  const diskKey = loadKeyFromDisk();
  if (diskKey && diskKey.length > 0) {
    return diskKey;
  }

  return null;
}

function computeStatusToken(key) {
  return crypto.createHash('sha256').update(`status:${key}`).digest('hex');
}

function getExpectedStatusToken() {
  const key = getServerKeyValue();
  if (!key) {
    return null;
  }
  return computeStatusToken(key);
}

export function isServerKeySet() {
  // Priority: ENV > Cached > Disk
  const envKey = loadKeyFromEnv();
  if (envKey && envKey.length > 0) return true;

  if (cachedKey && cachedKey.length > 0) return true;
  const key = loadKeyFromDisk();
  return !!(key && key.length > 0);
}

export function setServerKey(key) {
  // Prevent setting key when ENV key is present
  const envKey = loadKeyFromEnv();
  if (envKey) {
    throw new Error('Server key is set via environment variable and cannot be changed');
  }

  if (isServerKeySet()) {
    throw new Error('Server key already set');
  }
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('Invalid key');
  }
  const normalized = key.trim();
  try {
    fs.writeFileSync(KEY_FILE, JSON.stringify({ key: normalized }, null, 2), 'utf-8');
    cachedKey = normalized;
    logInfo('Server key has been set successfully');
  } catch (err) {
    logError('Failed to write server key to disk', err);
    throw err;
  }
}

export function verifyServerKey(provided) {
  if (!provided || typeof provided !== 'string') return false;

  // Priority: ENV > Cached > Disk
  const envKey = loadKeyFromEnv();
  const expected = envKey || cachedKey || loadKeyFromDisk();

  if (!expected) return false;
  return expected === provided.trim();
}

/**
 * Get the source of the server key for debugging/status display
 * @returns {'env'|'file'|null} - The source of the key, or null if not set
 */
export function getKeySource() {
  const envKey = loadKeyFromEnv();
  if (envKey && envKey.length > 0) return 'env';

  if (cachedKey && cachedKey.length > 0) return 'file';
  const diskKey = loadKeyFromDisk();
  if (diskKey && diskKey.length > 0) return 'file';

  return null;
}

function buildStatusCookie(token, maxAgeSeconds = STATUS_COOKIE_MAX_AGE) {
  const segments = [
    `${STATUS_COOKIE_NAME}=${token}`,
    'Path=/status',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (process.env.NODE_ENV === 'production') {
    segments.push('Secure');
  }
  return segments.join('; ');
}

function timingSafeCompare(token, expected) {
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (tokenBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(tokenBuffer, expectedBuffer);
}

export function getStatusCookieName() {
  return STATUS_COOKIE_NAME;
}

export function hasValidStatusCookie(cookieValue) {
  const expectedToken = getExpectedStatusToken();
  if (!expectedToken || !cookieValue) {
    return false;
  }
  try {
    return timingSafeCompare(cookieValue, expectedToken);
  } catch (error) {
    logDebug('Failed to compare status cookie token', error);
    return false;
  }
}

export function setStatusAuthCookie(res) {
  const expectedToken = getExpectedStatusToken();
  if (!expectedToken) {
    return;
  }
  const cookie = buildStatusCookie(expectedToken);
  if (typeof res.append === 'function') {
    res.append('Set-Cookie', cookie);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

export function clearStatusAuthCookie(res) {
  const cookie = buildStatusCookie('', 0);
  if (typeof res.append === 'function') {
    res.append('Set-Cookie', cookie);
  } else {
    res.setHeader('Set-Cookie', cookie);
  }
}

export function serverAuthMiddleware(req, res, next) {
  // Check if server authentication is enabled
  if (!isServerAuthEnabled()) {
    logDebug('Server authentication is disabled in config');
    return next();
  }

  const requestPath = req.path;
  const method = req.method ? req.method.toUpperCase() : 'GET';
  const isStatusPageRequest = method === 'GET' && (requestPath === '/status' || requestPath === '/status/');
  const isStatusLoginRequest = method === 'POST' && requestPath === '/status/login';

  // Status 页面（含登录）无需 Authorization 鉴权，由路由自行校验
  if (isStatusPageRequest || isStatusLoginRequest) {
    logDebug('Bypassing server auth for status page or login request');
    return next();
  }

  // If key is not set yet, block requests (except status setup) and instruct to set key
  if (!isServerKeySet()) {
    // 允许首次通过页面提交服务器密钥
    if (method === 'POST' && requestPath === '/status/set-key') {
      logDebug('Allowing server key setup without existing server key');
      return next();
    }

    return res.status(503).json({
      error: 'Server key not set',
      message: 'Set SERVER_AUTH_KEY environment variable or disable server authentication in config.json (set "enable_server_auth": false)'
    });
  }

  // Verify key for remaining routes
  const authHeader = req.headers['authorization'];
  let provided = null;
  if (typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
      provided = parts[1];
    }
  }
  if (!verifyServerKey(typeof provided === 'string' ? provided : '')) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization: Bearer <server-key>'
    });
  }

  return next();
}
