import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const KEYS = {
  SERVER_HOST: 'server_host',
  SERVER_PORT: 'server_port',
  USE_WSS: 'use_wss',
} as const;

export interface ServerSettings {
  host: string;
  port: number;
  useWss: boolean;
}

/**
 * In development the JS bundle is served by Metro running on the laptop, which
 * is normally the same machine as the Python hub. Use its LAN IP as the default
 * so the app connects without any manual configuration.
 */
function devServerHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.linkingUri ?? '';
  const match = hostUri.match(/^(?:[a-z]+:\/\/)?([^:/?#]+)/i);
  const host = match?.[1];
  if (!host || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.exp.direct')) return null;
  return host;
}

const DEFAULTS: ServerSettings = {
  host: devServerHost() ?? '192.168.1.25',
  port: 8000,
  useWss: false,
};

export async function loadSettings(): Promise<ServerSettings> {
  try {
    const [host, port, useWss] = await AsyncStorage.multiGet([
      KEYS.SERVER_HOST,
      KEYS.SERVER_PORT,
      KEYS.USE_WSS,
    ]);
    return {
      host: host[1] || DEFAULTS.host,
      port: port[1] ? parseInt(port[1], 10) : DEFAULTS.port,
      useWss: useWss[1] === 'true',
    };
  } catch {
    return DEFAULTS;
  }
}

export async function saveSettings(settings: ServerSettings): Promise<void> {
  await AsyncStorage.multiSet([
    [KEYS.SERVER_HOST, settings.host],
    [KEYS.SERVER_PORT, String(settings.port)],
    [KEYS.USE_WSS, String(settings.useWss)],
  ]);
}

export function buildWsUrl(settings: ServerSettings): string {
  const scheme = settings.useWss ? 'wss' : 'ws';
  return `${scheme}://${settings.host}:${settings.port}/ws/observer`;
}
