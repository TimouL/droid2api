import fs from 'fs';
import path from 'path';
import os from 'os';
import fetch from 'node-fetch';
import { logDebug, logError, logInfo } from './logger.js';
import { initializeKeyManager, getKeyManager } from './key-manager.js';
import { getChannelByEndpoint, getModelsByChannel } from './config.js';

// State management for API key and refresh
let currentApiKey = null;
let currentRefreshToken = null;
let lastRefreshTime = null;
let clientId = null;
let authSource = null; // 'env' or 'file' or 'factory_key' or 'factory_keys_file' or 'client'
let authFilePath = null;
let factoryApiKey = null; // From FACTORY_API_KEY environment variable (deprecated for multi-key)
let lastSelectedKey = null; // Track last selected key for result recording

// Client-provided keys statistics (for client authorization mode)
let clientKeysStats = new Map(); // key -> { success, fail, endpoints: Map<endpoint, {success, fail}> }
let clientKeysArray = []; // Ordered array for indexing: [{ key: originalKey, stats: statsRef }]
let lastClientKeyUpdate = null; // Track last update timestamp for client keys

const REFRESH_URL = 'https://api.workos.com/user_management/authenticate';
const REFRESH_INTERVAL_HOURS = 6; // Refresh every 6 hours
const TOKEN_VALID_HOURS = 8; // Token valid for 8 hours

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier)
 * Format: 26 characters using Crockford's Base32
 * First 10 chars: timestamp (48 bits)
 * Last 16 chars: random (80 bits)
 */
function generateULID() {
  // Crockford's Base32 alphabet (no I, L, O, U to avoid confusion)
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  
  // Get timestamp in milliseconds
  const timestamp = Date.now();
  
  // Encode timestamp to 10 characters
  let time = '';
  let ts = timestamp;
  for (let i = 9; i >= 0; i--) {
    const mod = ts % 32;
    time = ENCODING[mod] + time;
    ts = Math.floor(ts / 32);
  }
  
  // Generate 16 random characters
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    const rand = Math.floor(Math.random() * 32);
    randomPart += ENCODING[rand];
  }
  
  return time + randomPart;
}

/**
 * Generate a client ID in format: client_01{ULID}
 */
function generateClientId() {
  const ulid = generateULID();
  return `client_01${ulid}`;
}

/**
 * Load auth configuration with priority system
 * Priority: FACTORY_API_KEY > factory_keys.txt > refresh token mechanism > client authorization
 */
function loadAuthConfig() {
  // 1. Check FACTORY_API_KEY environment variable (highest priority)
  const factoryKey = process.env.FACTORY_API_KEY;
  if (factoryKey && factoryKey.trim() !== '') {
    // 支持分号分隔多个key
    const keys = factoryKey.split(';')
      .map(k => k.trim())
      .filter(k => k !== '');
    
    if (keys.length > 0) {
      logInfo(`Using API key(s) from FACTORY_API_KEY environment variable: ${keys.length} key(s)`);
      authSource = 'factory_key';
      return { type: 'factory_key', value: keys };
    }
  }

  // 2. Check factory_keys.txt file in project directory
  const keysFilePath = path.join(process.cwd(), 'factory_keys.txt');
  try {
    if (fs.existsSync(keysFilePath)) {
      const keysContent = fs.readFileSync(keysFilePath, 'utf-8');
      const keys = keysContent.split('\n')
        .map(k => k.trim())
        .filter(k => k !== '' && !k.startsWith('#')); // 过滤空行和注释行
      
      if (keys.length > 0) {
        logInfo(`Using API key(s) from factory_keys.txt: ${keys.length} key(s)`);
        authSource = 'factory_keys_file';
        return { type: 'factory_key', value: keys };
      }
    }
  } catch (error) {
    logError('Error reading factory_keys.txt', error);
  }

  // 3. Check refresh token mechanism (DROID_REFRESH_KEY)
  const envRefreshKey = process.env.DROID_REFRESH_KEY;
  if (envRefreshKey && envRefreshKey.trim() !== '') {
    logInfo('Using refresh token from DROID_REFRESH_KEY environment variable');
    authSource = 'env';
    authFilePath = path.join(process.cwd(), 'auth.json');
    return { type: 'refresh', value: envRefreshKey.trim() };
  }

  // 4. Check ~/.factory/auth.json
  const homeDir = os.homedir();
  const factoryAuthPath = path.join(homeDir, '.factory', 'auth.json');
  
  try {
    if (fs.existsSync(factoryAuthPath)) {
      const authContent = fs.readFileSync(factoryAuthPath, 'utf-8');
      const authData = JSON.parse(authContent);
      
      if (authData.refresh_token && authData.refresh_token.trim() !== '') {
        logInfo('Using refresh token from ~/.factory/auth.json');
        authSource = 'file';
        authFilePath = factoryAuthPath;
        
        // Also load access_token if available
        if (authData.access_token) {
          currentApiKey = authData.access_token.trim();
        }
        
        return { type: 'refresh', value: authData.refresh_token.trim() };
      }
    }
  } catch (error) {
    logError('Error reading ~/.factory/auth.json', error);
  }

  // 5. No configured auth found - will use client authorization
  logInfo('No auth configuration found, will use client authorization headers');
  authSource = 'client';
  return { type: 'client', value: null };
}

/**
 * Refresh API key using refresh token
 */
async function refreshApiKey() {
  if (!currentRefreshToken) {
    throw new Error('No refresh token available');
  }

  if (!clientId) {
    clientId = 'client_01HNM792M5G5G1A2THWPXKFMXB';
    logDebug(`Using fixed client ID: ${clientId}`);
  }

  logInfo('Refreshing API key...');

  try {
    // Create form data
    const formData = new URLSearchParams();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', currentRefreshToken);
    formData.append('client_id', clientId);

    const response = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    // Update tokens
    currentApiKey = data.access_token;
    currentRefreshToken = data.refresh_token;
    lastRefreshTime = Date.now();

    // Log user info
    if (data.user) {
      logInfo(`Authenticated as: ${data.user.email} (${data.user.first_name} ${data.user.last_name})`);
      logInfo(`User ID: ${data.user.id}`);
      logInfo(`Organization ID: ${data.organization_id}`);
    }

    // Save tokens to file
    saveTokens(data.access_token, data.refresh_token);

    logInfo(`New Refresh-Key: ${currentRefreshToken}`);
    logInfo('API key refreshed successfully');
    return data.access_token;

  } catch (error) {
    logError('Failed to refresh API key', error);
    throw error;
  }
}

/**
 * Save tokens to appropriate file
 */
function saveTokens(accessToken, refreshToken) {
  try {
    const authData = {
      access_token: accessToken,
      refresh_token: refreshToken,
      last_updated: new Date().toISOString()
    };

    // Ensure directory exists
    const dir = path.dirname(authFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // If saving to ~/.factory/auth.json, preserve other fields
    if (authSource === 'file' && fs.existsSync(authFilePath)) {
      try {
        const existingData = JSON.parse(fs.readFileSync(authFilePath, 'utf-8'));
        Object.assign(authData, existingData, {
          access_token: accessToken,
          refresh_token: refreshToken,
          last_updated: authData.last_updated
        });
      } catch (error) {
        logError('Error reading existing auth file, will overwrite', error);
      }
    }

    fs.writeFileSync(authFilePath, JSON.stringify(authData, null, 2), 'utf-8');
    logDebug(`Tokens saved to ${authFilePath}`);

  } catch (error) {
    logError('Failed to save tokens', error);
  }
}

/**
 * Check if API key needs refresh (older than 6 hours)
 */
function shouldRefresh() {
  if (!lastRefreshTime) {
    return true;
  }

  const hoursSinceRefresh = (Date.now() - lastRefreshTime) / (1000 * 60 * 60);
  return hoursSinceRefresh >= REFRESH_INTERVAL_HOURS;
}

/**
 * Initialize auth system - load auth config and setup initial API key if needed
 * @param {string} roundRobinAlgorithm - Key selection algorithm: 'weighted' or 'simple'
 * @param {boolean} removeOn402 - Whether to remove keys on 402 response
 */
export async function initializeAuth(roundRobinAlgorithm = 'weighted', removeOn402 = true) {
  try {
    const authConfig = loadAuthConfig();
    
    if (authConfig.type === 'factory_key') {
      // Using FACTORY_API_KEY or factory_keys.txt
      const keys = authConfig.value;
      if (Array.isArray(keys) && keys.length > 0) {
        // Initialize KeyManager with loaded keys
        initializeKeyManager(keys, roundRobinAlgorithm, removeOn402);
        logInfo(`Auth system initialized with ${keys.length} API key(s), algorithm: ${roundRobinAlgorithm}, removeOn402: ${removeOn402}`);
      } else {
        logError('Invalid keys configuration', new Error('Keys should be an array'));
      }
    } else if (authConfig.type === 'refresh') {
      // Using refresh token mechanism
      currentRefreshToken = authConfig.value;
      
      // Always refresh on startup to get fresh token
      await refreshApiKey();
      logInfo('Auth system initialized with refresh token mechanism');
    } else {
      // Using client authorization, no setup needed
      logInfo('Auth system initialized for client authorization mode');
    }
    
    logInfo('Auth system initialized successfully');
  } catch (error) {
    logError('Failed to initialize auth system', error);
    throw error;
  }
}

/**
 * Get API key based on configured authorization method
 * @param {string} clientAuthorization - Authorization header from client request (optional)
 */
export async function getApiKey(clientAuthorization = null) {
  // Priority 1: FACTORY_API_KEY or factory_keys.txt (using KeyManager)
  if (authSource === 'factory_key' || authSource === 'factory_keys_file') {
    const keyManager = getKeyManager();
    if (keyManager) {
      const selectedKey = keyManager.selectKey();
      lastSelectedKey = selectedKey; // Track for result recording
      return `Bearer ${selectedKey}`;
    }
    // Fallback for single key (backward compatibility)
    if (factoryApiKey) {
      lastSelectedKey = factoryApiKey;
      return `Bearer ${factoryApiKey}`;
    }
  }
  
  // Priority 2: Refresh token mechanism
  if (authSource === 'env' || authSource === 'file') {
    // Check if we need to refresh
    if (shouldRefresh()) {
      logInfo('API key needs refresh (6+ hours old)');
      await refreshApiKey();
    }

    if (!currentApiKey) {
      throw new Error('No API key available from refresh token mechanism.');
    }

    return `Bearer ${currentApiKey}`;
  }
  
  // Priority 3: Client authorization header
  if (clientAuthorization) {
    logDebug('Using client authorization header');
    // Extract the key for tracking (remove "Bearer " prefix)
    const keyMatch = clientAuthorization.match(/^Bearer\s+(.+)$/i);
    if (keyMatch) {
      lastSelectedKey = keyMatch[1]; // Track for result recording
    }
    return clientAuthorization;
  }

  // No authorization available
  throw new Error('No authorization available. Please configure FACTORY_API_KEY, refresh token, or provide client authorization.');
}

/**
 * Record request result for key statistics
 * @param {string} endpoint - The endpoint URL
 * @param {boolean} success - Whether the request was successful (2xx status)
 * @param {number} statusCode - HTTP status code
 * @param {string} modelId - Model ID used in the request (optional)
 * @param {string} modelName - Model name used in the request (optional)
 */
export function recordRequestResult(endpoint, success, statusCode, modelId = null, modelName = null) {
  if ((authSource === 'factory_key' || authSource === 'factory_keys_file') && lastSelectedKey) {
    const keyManager = getKeyManager();
    if (keyManager) {
      keyManager.recordResult(lastSelectedKey, endpoint, success, statusCode, modelId, modelName);
    }
  } else if (authSource === 'client' && lastSelectedKey) {
    // Record statistics for client-provided keys
    let isNewKey = false;
    if (!clientKeysStats.has(lastSelectedKey)) {
      clientKeysStats.set(lastSelectedKey, {
        success: 0,
        fail: 0,
        endpoints: new Map()
      });
      // Add to ordered array for indexing
      clientKeysArray.push({
        key: lastSelectedKey,
        stats: clientKeysStats.get(lastSelectedKey)
      });
      isNewKey = true;
    }

    const keyStats = clientKeysStats.get(lastSelectedKey);

    // Update key-level stats
    if (success) {
      keyStats.success++;
    } else {
      keyStats.fail++;
    }

    // Update endpoint-level stats (按 endpoint+model 维度)
    if (modelId && modelName) {
      const statsKey = `${endpoint}::${modelId}`;
      if (!keyStats.endpoints.has(statsKey)) {
        keyStats.endpoints.set(statsKey, {
          success: 0,
          fail: 0,
          modelId,
          modelName,
          endpoint
        });
      }
      const endpointStats = keyStats.endpoints.get(statsKey);
      if (success) {
        endpointStats.success++;
      } else {
        endpointStats.fail++;
      }
    } else {
      // 向后兼容:如果没有提供 model 信息,按 endpoint 维度记录
      if (!keyStats.endpoints.has(endpoint)) {
        keyStats.endpoints.set(endpoint, { success: 0, fail: 0, endpoint });
      }
      const endpointStats = keyStats.endpoints.get(endpoint);
      if (success) {
        endpointStats.success++;
      } else {
        endpointStats.fail++;
      }
    }

    // Update last update timestamp (especially important for new keys)
    if (isNewKey || success || !success) {
      lastClientKeyUpdate = Date.now();
    }

    logDebug(`Client key stats updated: ${maskKey(lastSelectedKey)} - Success: ${keyStats.success}, Fail: ${keyStats.fail}${isNewKey ? ' (NEW KEY)' : ''}`);
  }
}

/**
 * Mask key for display (show first 6 and last 6 characters)
 */
function maskKey(key) {
  if (!key || key.length <= 12) {
    return '******';
  }
  return `${key.substring(0, 6)}******${key.substring(key.length - 6)}`;
}

/**
 * Get client keys statistics (for status page)
 * @returns {object} Statistics object compatible with KeyManager.getStats()
 */
export function getClientKeysStats() {
  if (authSource !== 'client' || clientKeysStats.size === 0) {
    return null;
  }

  // Aggregate endpoint stats across all keys
  const globalEndpointStats = new Map();

  const keys = clientKeysArray.map((entry, index) => {
    const stats = entry.stats;

    // Aggregate endpoint stats
    stats.endpoints.forEach((endpointStats, statsKey) => {
      if (!globalEndpointStats.has(statsKey)) {
        // 保留完整的统计信息,包括 endpoint、modelId、modelName
        globalEndpointStats.set(statsKey, {
          success: 0,
          fail: 0,
          endpoint: endpointStats.endpoint,
          modelId: endpointStats.modelId,
          modelName: endpointStats.modelName
        });
      }
      const globalStats = globalEndpointStats.get(statsKey);
      globalStats.success += endpointStats.success;
      globalStats.fail += endpointStats.fail;
    });

    return {
      index, // Add index for balance query
      key: maskKey(entry.key),
      success: stats.success,
      fail: stats.fail,
      total: stats.success + stats.fail,
      successRate: stats.success + stats.fail > 0
        ? ((stats.success / (stats.success + stats.fail)) * 100).toFixed(2) + '%'
        : 'N/A',
      depleted: false
    };
  });

  const endpoints = Array.from(globalEndpointStats.entries())
    .filter(([_, stats]) => stats.success > 0 || stats.fail > 0)
    .map(([key, stats]) => {
      // 判断是新格式(endpoint::model)还是旧格式(endpoint)
      const isNewFormat = stats.modelId && stats.modelName;

      if (isNewFormat) {
        // 新格式:按 model 维度展示
        const channel = getChannelByEndpoint(stats.endpoint);
        return {
          endpoint: stats.endpoint,
          channel: channel || 'unknown',
          model: stats.modelName,
          modelId: stats.modelId,
          success: stats.success,
          fail: stats.fail,
          total: stats.success + stats.fail,
          successRate: stats.success + stats.fail > 0
            ? ((stats.success / (stats.success + stats.fail)) * 100).toFixed(2) + '%'
            : 'N/A'
        };
      } else {
        // 旧格式(向后兼容):按 endpoint 维度展示,包含该 channel 下的所有 models
        const endpoint = stats.endpoint || key;
        const channel = getChannelByEndpoint(endpoint);
        const models = channel ? getModelsByChannel(channel) : [];

        return {
          endpoint,
          channel: channel || 'unknown',
          models: models.map(m => ({ name: m.name, id: m.id })),
          success: stats.success,
          fail: stats.fail,
          total: stats.success + stats.fail,
          successRate: stats.success + stats.fail > 0
            ? ((stats.success / (stats.success + stats.fail)) * 100).toFixed(2) + '%'
            : 'N/A'
        };
      }
    });

  return {
    algorithm: 'client',
    removeOn402: false,
    keys,
    deprecatedKeys: [],
    endpoints
  };
}

/**
 * Get client key by index (for balance query)
 * @param {number} index - Key index
 * @returns {string|null} Original key or null if not found
 */
export function getClientKeyByIndex(index) {
  if (authSource !== 'client' || index < 0 || index >= clientKeysArray.length) {
    return null;
  }
  return clientKeysArray[index].key;
}

/**
 * Get last client key update timestamp
 * @returns {number|null} Timestamp or null if no updates
 */
export function getLastClientKeyUpdate() {
  return lastClientKeyUpdate;
}
