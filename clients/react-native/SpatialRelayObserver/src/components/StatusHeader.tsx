import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { WsStatus } from '../hooks/useWebSocket';
import { MONO_FONT } from '../lib/fonts';

interface Props {
  wsStatus: WsStatus;
  wsUrl: string | null;
  mediaPipeStatus: 'idle' | 'loading' | 'ready' | 'error';
  poseX: number;
  poseZ: number;
  yawDeg: number;
  onSettingsPress: () => void;
  onReconnect: () => void;
}

const STATUS_COLORS: Record<WsStatus, string> = {
  connected:    '#bafa59',
  connecting:   '#f4b942',
  disconnected: '#ff4d4d',
};

const MP_LABELS: Record<string, string> = {
  idle:    'Detection off',
  loading: 'Loading model…',
  ready:   'Detection ●',
  error:   'Detection err',
};

const MP_COLORS: Record<string, string> = {
  idle:    '#888',
  loading: '#f4b942',
  ready:   '#bafa59',
  error:   '#ff4d4d',
};

export function StatusHeader({
  wsStatus,
  wsUrl,
  mediaPipeStatus,
  poseX,
  poseZ,
  yawDeg,
  onSettingsPress,
  onReconnect,
}: Props) {
  const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

  return (
    <View style={styles.container}>
      {/* Left: connection indicator */}
      <TouchableOpacity style={styles.wsBlock} onPress={onReconnect} activeOpacity={0.7}>
        <View style={[styles.dot, { backgroundColor: STATUS_COLORS[wsStatus] }]} />
        <Text style={[styles.wsText, { color: STATUS_COLORS[wsStatus] }]}>
          {wsStatus === 'connected' ? 'HUB' : wsStatus.toUpperCase()}
        </Text>
      </TouchableOpacity>
      {wsStatus !== 'connected' && wsUrl && (
        <Text style={styles.urlText} numberOfLines={1}>{wsUrl.replace(/^wss?:\/\//, '').replace('/ws/observer', '')}</Text>
      )}

      {/* Centre: pose readout */}
      <View style={styles.poseBlock}>
        <Text style={styles.poseText}>
          X{fmt(poseX)}  Z{fmt(poseZ)}  {yawDeg.toFixed(0)}°
        </Text>
        <Text style={[styles.mpText, { color: MP_COLORS[mediaPipeStatus] }]}>
          {MP_LABELS[mediaPipeStatus]}
        </Text>
      </View>

      {/* Right: settings */}
      <TouchableOpacity style={styles.settingsBtn} onPress={onSettingsPress} activeOpacity={0.7}>
        <Text style={styles.settingsIcon}>⚙</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(10,10,10,0.75)',
    gap: 8,
  },
  wsBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 80,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  wsText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: MONO_FONT,
  },
  urlText: {
    color: '#777',
    fontSize: 10,
    fontFamily: MONO_FONT,
    maxWidth: 110,
  },
  poseBlock: {
    flex: 1,
    alignItems: 'center',
  },
  poseText: {
    color: '#e0e0e0',
    fontSize: 12,
    fontFamily: MONO_FONT,
  },
  mpText: {
    fontSize: 11,
    fontFamily: MONO_FONT,
    marginTop: 2,
  },
  settingsBtn: {
    padding: 4,
    minWidth: 36,
    alignItems: 'flex-end',
  },
  settingsIcon: {
    fontSize: 20,
    color: '#aaa',
  },
});
