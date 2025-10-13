import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let config = null;

export function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(configData);
    return config;
  } catch (error) {
    throw new Error(`Failed to load config.json: ${error.message}`);
  }
}

export function getConfig() {
  if (!config) {
    loadConfig();
  }
  return config;
}

export function getModelById(modelId) {
  const cfg = getConfig();
  return cfg.models.find(m => m.id === modelId);
}

export function getEndpointByType(type) {
  const cfg = getConfig();
  return cfg.endpoint.find(e => e.name === type);
}

export function isDevMode() {
  const cfg = getConfig();
  return cfg.dev_mode === true;
}

export function getPort() {
  const cfg = getConfig();
  return cfg.port || 3000;
}

export function getSystemPrompt() {
  const cfg = getConfig();
  return cfg.system_prompt || '';
}

export function getSystemPromptMode() {
  const cfg = getConfig();
  const mode = cfg.system_prompt_mode || 'replace';
  // 验证配置值
  if (!['replace', 'prepend', 'append', 'off'].includes(mode)) {
    return 'replace'; // 默认值
  }
  return mode;
}

export function getModelReasoning(modelId) {
  const model = getModelById(modelId);
  if (!model || !model.reasoning) {
    return null;
  }
  const reasoningLevel = model.reasoning.toLowerCase();
  if (['low', 'medium', 'high', 'auto'].includes(reasoningLevel)) {
    return reasoningLevel;
  }
  return null;
}

export function getUserAgent() {
  const cfg = getConfig();
  return cfg.user_agent || 'factory-cli/0.19.3';
}

export function getRoundRobin() {
  const cfg = getConfig();
  const roundRobin = cfg['round-robin'] || 'weighted';
  // 验证配置值
  if (!['weighted', 'simple'].includes(roundRobin)) {
    return 'weighted'; // 默认值
  }
  return roundRobin;
}

export function getRemoveOn402() {
  const cfg = getConfig();
  // 默认值为true
  return cfg.remove_on_402 !== false;
}

export function isServerAuthEnabled() {
  // 优先级：环境变量 > 配置文件
  const envValue = process.env.ENABLE_SERVER_AUTH;
  if (envValue !== undefined) {
    // 环境变量存在时，解析其值
    // 支持: true/1/yes/on -> true, false/0/no/off -> false
    const normalized = envValue.toLowerCase().trim();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  // 回退到配置文件
  const cfg = getConfig();
  // 默认值为true(启用服务器认证)
  return cfg.enable_server_auth !== false;
}

/**
 * Get channel name by endpoint URL
 * @param {string} endpointUrl - The endpoint base URL
 * @returns {string|null} Channel name or null if not found
 */
export function getChannelByEndpoint(endpointUrl) {
  const cfg = getConfig();
  const endpoint = cfg.endpoint.find(e => e.base_url === endpointUrl);
  return endpoint ? endpoint.name : null;
}

/**
 * Get models by channel type
 * @param {string} channelType - The channel type (e.g., 'anthropic', 'openai', 'common')
 * @returns {Array} Array of model objects for the specified channel
 */
export function getModelsByChannel(channelType) {
  const cfg = getConfig();
  return cfg.models.filter(m => m.type === channelType);
}
