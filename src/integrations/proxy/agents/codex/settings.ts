// Codex CLI settings management (~/.codex/config.toml)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse, stringify } from 'smol-toml';

const CODEX_DIR = join(homedir(), '.codex');
const CONFIG_PATH = join(CODEX_DIR, 'config.toml');
const PROXY_URL = 'http://127.0.0.1:8080/v1';

interface ModelProvider {
  name: string;
  base_url: string;
  env_key: string;
  wire_api: 'responses' | 'chat';
  query_params?: Record<string, string>;
  http_headers?: Record<string, string>;
}

interface CodexConfig {
  model_providers?: Record<string, ModelProvider>;
  [key: string]: unknown;
}

export function getSettingsPath(): string {
  return CONFIG_PATH;
}

export function readCodexConfig(): CodexConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    return parse(content) as CodexConfig;
  } catch {
    return {};
  }
}

function writeCodexConfig(config: CodexConfig): void {
  if (!existsSync(CODEX_DIR)) {
    mkdirSync(CODEX_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_PATH, stringify(config), { mode: 0o600 });
}

export function setProxyEnv(enable: boolean): { action: 'added' | 'removed' | 'unchanged' } {
  const config = readCodexConfig();

  if (enable) {
    if (!config.model_providers) {
      config.model_providers = {};
    }

    if (config.model_providers.grov?.base_url === PROXY_URL) {
      return { action: 'unchanged' };
    }

    config.model_providers.grov = {
      name: 'Grov Memory Proxy',
      base_url: PROXY_URL,
      env_key: 'OPENAI_API_KEY',
      wire_api: 'responses',
    };

    writeCodexConfig(config);
    return { action: 'added' };
  }

  if (!config.model_providers?.grov) {
    return { action: 'unchanged' };
  }

  delete config.model_providers.grov;

  if (Object.keys(config.model_providers).length === 0) {
    delete config.model_providers;
  }

  writeCodexConfig(config);
  return { action: 'removed' };
}
