import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MONO_FONT } from '../lib/fonts';

interface DPadProps {
  /** Step size in metres per button press (default 0.5). */
  step?: number;
  onMove: (axis: 'x' | 'z', delta: number) => void;
  onReset: () => void;
}

/**
 * Cross-shaped D-pad for manually adjusting X/Z phone position.
 *
 * This is the equivalent of the web phone.js D-pad buttons.
 * The server accepts manual_pose packets; this sets the position component.
 * Orientation comes from the DeviceMotion hook — not from this component.
 *
 * Up   (+Z forward)  ↑
 * Down (-Z back)     ↓
 * Left (-X)          ←
 * Right(+X)          →
 */
export function DPad({ step = 0.5, onMove, onReset }: DPadProps) {
  const Btn = ({
    label,
    onPress,
    style,
  }: {
    label: string;
    onPress: () => void;
    style?: object;
  }) => (
    <TouchableOpacity
      style={[styles.btn, style]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={styles.btnText}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Up */}
      <View style={styles.row}>
        <Btn label="↑" onPress={() => onMove('z', step)} />
      </View>

      {/* Middle row: Left · Reset · Right */}
      <View style={styles.row}>
        <Btn label="←" onPress={() => onMove('x', -step)} />
        <TouchableOpacity style={[styles.btn, styles.resetBtn]} onPress={onReset} activeOpacity={0.7}>
          <Text style={[styles.btnText, { fontSize: 10, color: '#888' }]}>RST</Text>
        </TouchableOpacity>
        <Btn label="→" onPress={() => onMove('x', step)} />
      </View>

      {/* Down */}
      <View style={styles.row}>
        <Btn label="↓" onPress={() => onMove('z', -step)} />
      </View>

      {/* Fine step row */}
      <View style={[styles.row, { marginTop: 6, gap: 6 }]}>
        <TouchableOpacity style={styles.fineBtn} onPress={() => onMove('x', -0.1)} activeOpacity={0.7}>
          <Text style={styles.fineBtnText}>−0.1 X</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.fineBtn} onPress={() => onMove('z', 0.1)} activeOpacity={0.7}>
          <Text style={styles.fineBtnText}>+0.1 Z</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.fineBtn} onPress={() => onMove('z', -0.1)} activeOpacity={0.7}>
          <Text style={styles.fineBtnText}>−0.1 Z</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.fineBtn} onPress={() => onMove('x', 0.1)} activeOpacity={0.7}>
          <Text style={styles.fineBtnText}>+0.1 X</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const BTN_SIZE = 52;

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  btn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: 10,
    backgroundColor: 'rgba(186,250,89,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(186,250,89,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  btnText: {
    color: '#bafa59',
    fontSize: 22,
    fontWeight: '600',
  },
  resetBtn: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderColor: '#444',
  },
  fineBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: '#333',
  },
  fineBtnText: {
    color: '#aaa',
    fontSize: 11,
    fontFamily: MONO_FONT,
  },
});
