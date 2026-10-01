import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import type { WsStatus } from '../hooks/useWebSocket';

interface Props {
  wsStatus: WsStatus;
  /** Human-readable reason the hub is unreachable, if it is. */
  wsError: string | null;
  /** Reconnect attempts since the last successful connection. */
  wsAttempt: number;
  /** The hub address actually being dialled, so a wrong IP is visible. */
  wsUrl: string | null;
  /**
   * Status of the on-device tracking pipeline. ARKit supplies the production
   * value; the MediaPipe state keys are still accepted for the no-ARKit
   * fallback path.
   */
  mediaPipeStatus: string;
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
  // ARKit states, produced by `arkitStatusLabel` in ObserverScreen.
  'arkit: tracking':      'ARKit ● tracking',
  'arkit: limited':       'ARKit limited',
  'arkit: searching':     'ARKit searching…',
  'arkit: stopped':       'ARKit stopped',
  'arkit: checking…':     'ARKit checking…',
  'arkit: unsupported':   'ARKit unsupported',
  'arkit: no camera access': 'ARKit no camera',
  'arkit: no native module': 'ARKit not linked',
};

const MP_COLORS: Record<string, string> = {
  idle:    '#888',
  loading: '#f4b942',
  ready:   '#bafa59',
  error:   '#ff4d4d',
  'arkit: tracking':         '#bafa59',
  'arkit: limited':          '#f4b942',
  'arkit: searching':        '#f4b942',
  'arkit: stopped':          '#ff4d4d',
  'arkit: checking…':        '#888',
  'arkit: unsupported':      '#ff4d4d',
  'arkit: no camera access': '#ff4d4d',
  'arkit: no native module': '#ff4d4d',
};

export function StatusHeader({
  wsStatus,
  wsError,
  wsAttempt,
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
      {/* Left: connection indicator. Tapping retries immediately. */}
      <TouchableOpacity style={styles.wsBlock} onPress={onReconnect} activeOpacity={0.7}>
        <View style={[styles.dot, { backgroundColor: STATUS_COLORS[wsStatus] }]} />
        <Text style={[styles.wsText, { color: STATUS_COLORS[wsStatus] }]}>
          {wsStatus === 'connected'
            ? 'HUB'
            : wsStatus === 'connecting'
              ? `CONNECTING${wsAttempt > 0 ? ` #${wsAttempt}` : ''}`
              : `OFFLINE${wsAttempt > 0 ? ` #${wsAttempt}` : ''}`}
        </Text>
      </TouchableOpacity>

      {/* Centre: pose readout */}
      <View style={styles.poseBlock}>
        <Text style={styles.poseText}>
          X{fmt(poseX)}  Z{fmt(poseZ)}  {yawDeg.toFixed(0)}°
        </Text>
        <Text
          style={[
            styles.mpText,
            { color: MP_COLORS[mediaPipeStatus] ?? '#888' },
          ]}
        >
          {MP_LABELS[mediaPipeStatus] ?? mediaPipeStatus}
        </Text>
      </View>

      {/* Right: settings */}
      <TouchableOpacity style={styles.settingsBtn} onPress={onSettingsPress} activeOpacity={0.7}>
        <Text style={styles.settingsIcon}>⚙</Text>
      </TouchableOpacity>

      {/* Banner: always show the address being dialled while not connected, so
          a wrong or placeholder IP is obvious instead of guessing. */}
      {wsStatus !== 'connected' ? (
        <TouchableOpacity style={styles.errorBanner} onPress={onReconnect} activeOpacity={0.7}>
          <Text style={styles.errorUrl}>
            {wsUrl ? wsUrl : 'loading settings…'}
          </Text>
          {wsError ? <Text style={styles.errorText}>{wsError}</Text> : null}
          <Text style={styles.errorHint}>Tap to retry now · ⚙ to change IP</Text>
        </TouchableOpacity>
      ) : null}
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
    flexWrap: 'wrap',
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
    fontFamily: 'monospace',
  },
  poseBlock: {
    flex: 1,
    alignItems: 'center',
  },
  poseText: {
    color: '#e0e0e0',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  mpText: {
    fontSize: 11,
    fontFamily: 'monospace',
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
  errorBanner: {
    width: '100%',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'rgba(255,77,77,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,77,0.5)',
  },
  errorText: {
    color: '#ffb3b3',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  errorUrl: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 3,
  },
  errorHint: {
    color: '#c88',
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 3,
  },
});
