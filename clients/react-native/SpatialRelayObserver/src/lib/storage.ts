import AsyncStorage from '@react-native-async-storage/async-storage';

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
 * Placeholder LAN address. It is intentionally not a real host: the phone's
 * actual address is set once via the Settings modal and then persisted, so
 * this value only controls what the preview shows before that first save.
 */
export const DEFAULT_SETTINGS: ServerSettings = {
  host: '192.168.1.100',
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
    const parsedPort = port[1] ? parseInt(port[1], 10) : NaN;
    return {
      host: host[1]?.trim() || DEFAULT_SETTINGS.host,
      port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_SETTINGS.port,
      useWss: useWss[1] === 'true',
    };
  } catch {
    return DEFAULT_SETTINGS;
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
