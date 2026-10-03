import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Slider from '@react-native-community/slider';
import { MONO_FONT } from '../lib/fonts';

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Depth is estimated from the detected body size instead of the slider. */
  auto?: boolean;
  onToggleAuto?: () => void;
}

/**
 * Depth / range slider (0.5 m – 10.0 m) with an AUTO toggle.
 *
 * In AUTO mode the depth is estimated from the person's torso length
 * (MediaPipe world landmarks vs. image size); dragging the slider switches
 * back to manual.
 *
 * Replaces the manual range `<input type="range">` from the web phone.js.
 * This value is used in toPhonePoint() to back-project screen landmarks into
 * phone-local 3D coordinates. When LiDAR is available (via a custom native
 * module), this slider can be bypassed in favour of per-pixel measured depth.
 */
export function RangeSlider({ value, onChange, min = 0.5, max = 10.0, auto, onToggleAuto }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>
          Range: <Text style={styles.value}>{value.toFixed(1)} m</Text>
        </Text>
        {onToggleAuto && (
          <TouchableOpacity
            style={[styles.autoBtn, auto && styles.autoBtnOn]}
            onPress={onToggleAuto}
            activeOpacity={0.7}
          >
            <Text style={[styles.autoText, auto && styles.autoTextOn]}>AUTO</Text>
          </TouchableOpacity>
        )}
      </View>
      <Slider
        style={styles.slider}
        minimumValue={min}
        maximumValue={max}
        step={0.1}
        value={value}
        onValueChange={onChange}
        minimumTrackTintColor="#bafa59"
        maximumTrackTintColor="#333"
        thumbTintColor="#bafa59"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  autoBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#444',
  },
  autoBtnOn: {
    borderColor: '#bafa59',
    backgroundColor: 'rgba(186,250,89,0.12)',
  },
  autoText: {
    color: '#777',
    fontSize: 10,
    fontWeight: '700',
  },
  autoTextOn: {
    color: '#bafa59',
  },
  label: {
    color: '#888',
    fontSize: 12,
    fontFamily: MONO_FONT,
    textAlign: 'center',
  },
  value: {
    color: '#bafa59',
    fontWeight: '700',
  },
  slider: {
    width: '100%',
    height: 36,
  },
});
