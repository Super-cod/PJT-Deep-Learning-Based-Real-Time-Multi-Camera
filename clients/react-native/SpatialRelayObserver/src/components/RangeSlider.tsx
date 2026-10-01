import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Slider from '@react-native-community/slider';

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}

/**
 * Depth / range slider (0.5 m – 10.0 m).
 *
 * Replaces the manual range `<input type="range">` from the web phone.js.
 * This value is used in toPhonePoint() to back-project screen landmarks into
 * phone-local 3D coordinates. When LiDAR is available (via a custom native
 * module), this slider can be bypassed in favour of per-pixel measured depth.
 */
export function RangeSlider({ value, onChange, min = 0.5, max = 10.0 }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        Range: <Text style={styles.value}>{value.toFixed(1)} m</Text>
      </Text>
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
  label: {
    color: '#888',
    fontSize: 12,
    fontFamily: 'monospace',
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
