import { Platform } from 'react-native';

/** 'monospace' is not a valid font family on iOS — use Menlo there. */
export const MONO_FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });
