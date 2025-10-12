import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_FILE = path.join(__dirname, 'server-key.json');
const ENV_KEY_NAME = 'SERVER_AUTH_KEY';

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

export function serverAuthMiddleware(req, res, next) {
  // Allow status and its subpaths without key
  const path = req.path || req.originalUrl || '';
  if (path === '/status' || path.startsWith('/status/')) {
    return next();
  }

  // If key is not set yet, block all other routes and instruct to visit /status
  if (!isServerKeySet()) {
    return res.status(503).json({
      error: 'Server key not set',
      message: 'Visit /status to set the initial access key.'
    });
  }

  // Accept key via Authorization: Bearer <key>
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
