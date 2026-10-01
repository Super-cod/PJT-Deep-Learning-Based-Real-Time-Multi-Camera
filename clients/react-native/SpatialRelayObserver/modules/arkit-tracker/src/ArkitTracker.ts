import { requireOptionalNativeModule } from 'expo-modules-core';

import type { ArkitModule } from './ArkitTracker.types';

/**
 * Resolves to `null` on Android, the simulator, or Expo Go, where the Swift
 * module is not compiled in. Callers must treat a null module as "ARKit is
 * unavailable" rather than throwing, so the screen can fall back gracefully.
 */
export const ArkitTracker: ArkitModule | null =
  requireOptionalNativeModule<ArkitModule>('ArkitTracker');

export * from './ArkitTracker.types';
