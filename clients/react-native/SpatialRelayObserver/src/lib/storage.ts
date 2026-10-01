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

const DEFAULTS: ServerSettings = {
  host: '172.20.167.11',
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
      host: host[1] ?? DEFAULTS.host,
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
