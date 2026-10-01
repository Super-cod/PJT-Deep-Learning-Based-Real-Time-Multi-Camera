import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { ObserverScreen } from './src/screens/ObserverScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ObserverScreen />
    </SafeAreaProvider>
  );
}
