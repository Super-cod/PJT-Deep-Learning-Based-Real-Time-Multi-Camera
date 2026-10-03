import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import type { ServerSettings } from '../lib/storage';
import { MONO_FONT } from '../lib/fonts';

interface Props {
  visible: boolean;
  settings: ServerSettings;
  onSave: (s: ServerSettings) => void;
  onClose: () => void;
}

/**
 * Server configuration modal.
 *
 * Lets the user set:
 *  - Laptop LAN IP address (replaces hardcoded `serverHost` in WebSocketRelay.swift)
 *  - Port (default 8000)
 *  - ws:// vs wss:// (enable if you add TLS to uvicorn)
 *
 * Settings are persisted to AsyncStorage.
 */
export function SettingsModal({ visible, settings, onSave, onClose }: Props) {
  const [host, setHost]       = useState(settings.host);
  const [port, setPort]       = useState(String(settings.port));
  const [useWss, setUseWss]   = useState(settings.useWss);

  // Re-sync local state when settings prop changes (e.g., on first load)
  React.useEffect(() => {
    setHost(settings.host);
    setPort(String(settings.port));
    setUseWss(settings.useWss);
  }, [settings]);

  const handleSave = () => {
    const parsedPort = parseInt(port, 10);
    onSave({
      host: host.trim(),
      port: isNaN(parsedPort) ? 8000 : parsedPort,
      useWss,
    });
  };

  const preview = `${useWss ? 'wss' : 'ws'}://${host.trim()}:${port}/ws/observer`;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Server Settings</Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Host */}
            <Text style={styles.label}>Laptop LAN IP Address</Text>
            <TextInput
              style={styles.input}
              value={host}
              onChangeText={setHost}
              placeholder="192.168.1.25"
              placeholderTextColor="#555"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
            />

            {/* Port */}
            <Text style={styles.label}>Port</Text>
            <TextInput
              style={styles.input}
              value={port}
              onChangeText={setPort}
              placeholder="8000"
              placeholderTextColor="#555"
              keyboardType="number-pad"
            />

            {/* WSS toggle */}
            <View style={styles.switchRow}>
              <View>
                <Text style={styles.label}>Use wss:// (TLS)</Text>
                <Text style={styles.sublabel}>Enable if uvicorn uses --ssl-keyfile</Text>
              </View>
              <Switch
                value={useWss}
                onValueChange={setUseWss}
                trackColor={{ false: '#333', true: '#4a7c29' }}
                thumbColor={useWss ? '#bafa59' : '#888'}
              />
            </View>

            {/* Preview */}
            <Text style={styles.preview}>{preview}</Text>

            {/* Hint */}
            <Text style={styles.hint}>
              Find the laptop IP with{' '}
              <Text style={styles.code}>ipconfig</Text> (Windows) or{' '}
              <Text style={styles.code}>ip addr</Text> (Linux). Both devices must
              be on the same Wi-Fi network.
            </Text>

            {/* Save */}
            <TouchableOpacity style={styles.saveBtn} onPress={handleSave} activeOpacity={0.8}>
              <Text style={styles.saveBtnText}>Save & Reconnect</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderColor: '#222',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    color: '#888',
    fontSize: 20,
    padding: 4,
  },
  label: {
    color: '#aaa',
    fontSize: 13,
    marginBottom: 6,
    marginTop: 14,
  },
  sublabel: {
    color: '#555',
    fontSize: 11,
    marginTop: 2,
  },
  input: {
    backgroundColor: '#1a1a1a',
    color: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: MONO_FONT,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
  },
  preview: {
    color: '#bafa59',
    fontSize: 12,
    fontFamily: MONO_FONT,
    textAlign: 'center',
    marginTop: 16,
    padding: 10,
    backgroundColor: '#0d1a0d',
    borderRadius: 8,
  },
  hint: {
    color: '#555',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
  },
  code: {
    color: '#888',
    fontFamily: MONO_FONT,
    backgroundColor: '#1a1a1a',
  },
  saveBtn: {
    marginTop: 24,
    backgroundColor: '#bafa59',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#0a0a0a',
    fontSize: 15,
    fontWeight: '700',
  },
});
