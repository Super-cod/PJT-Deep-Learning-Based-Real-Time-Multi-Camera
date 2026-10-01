#!/usr/bin/env bash
# Build and install the ARKit development client on a physical iPhone.
#
# ARKit cannot run in Expo Go, so a native build is required. This script does
# the whole loop: prebuild, pod install, run on device, and fall back to an EAS
# development build when no local Xcode device is available.
#
# Usage:
#   ./scripts/build_ios_dev.sh              # prebuild + run on a connected iPhone
#   ./scripts/build_ios_dev.sh eas          # skip Xcode, build via EAS cloud
#   ./scripts/build_ios_dev.sh clean        # wipe ios/ and rebuild from scratch
#
# Requirements: macOS with Xcode 16+, Node 20+, CocoaPods, and a connected
# iPhone with Developer Mode enabled (Settings > Privacy & Security > Developer
# Mode). An Apple Developer account is required to sign the app.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

BUNDLE_ID="com.spatialrelay.observer"
MODE="${1:-local}"

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────────────
say "Checking the toolchain"
if [ "$(uname -s)" != "Darwin" ]; then
  die "ARKit builds require macOS with Xcode. Windows cannot compile the iOS target."
fi
command -v node >/dev/null || die "Node is not installed (need Node 20+)."
command -v npx  >/dev/null || die "npx is not available."
command -v pod  >/dev/null || die "CocoaPods is not installed. Run: sudo gem install cocoapods"
command -v eas  >/dev/null || command -v npx >/dev/null || die "Install EAS CLI: npm i -g eas-cli"
xcodebuild -version >/dev/null 2>&1 || die "Xcode is not installed or not selected."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || warn "Node $(node -v) detected; Node 20+ is recommended."

echo "  node    $(node -v)"
echo "  xcode   $(xcodebuild -version | head -1)"
echo "  expo    $(node -p "require('./package.json').dependencies.expo")"

# ── Dependencies ───────────────────────────────────────────────────────────────
say "Installing JS dependencies"
# `expo-modules-core` is nested inside the `expo` package, so it is present once
# `expo` is installed. A direct dependency is added for the local Swift module so
# the autolinker resolves it without relying on hoisting.
if ! node -e "require.resolve('expo-modules-core')" >/dev/null 2>&1; then
  warn "expo-modules-core is not directly resolvable; adding it"
  npx expo install expo-modules-core
fi
npm install

# ── Build ──────────────────────────────────────────────────────────────────────
if [ "$MODE" = "clean" ]; then
  say "Removing ios/ for a clean prebuild"
  rm -rf ios
  MODE="local"
fi

if [ "$MODE" = "eas" ]; then
  say "Building a development client with EAS"
  # A dev client is required: Expo Go cannot load a custom native ARKit module.
  eas build --platform ios --profile development --local false
  say "Done. Install the build on the iPhone, then run: npx expo start --dev-client"
  exit 0
fi

say "Generating the native iOS project"
# --clean is deliberately not used: it rewrites ios/ and can discard manual
# Xcode settings. Run './scripts/build_ios_dev.sh clean' to force a rebuild.
npx expo prebuild --platform ios --no-install

say "Installing CocoaPods dependencies"
# The local Swift module in modules/arkit-tracker is picked up by Expo's
# autolinking during pod install.
( cd ios && pod install )

say "Confirming the ARKit module is autolinked"
if grep -q "ArkitTracker" ios/Podfile.lock; then
  echo "  ArkitTracker is linked into the Pods project"
else
  warn "ArkitTracker was not found in Podfile.lock."
  warn "Check modules/arkit-tracker/expo-module.config.json declares the module."
  warn "Try: npx expo prebuild --platform ios --clean && (cd ios && pod install)"
fi

say "Building and installing on the connected iPhone"
DEVICE_ID="$(xcrun xctrace list devices 2>/dev/null | grep -iE 'iPhone' | grep -v Simulator | head -1 | sed -E 's/.*\(([0-9A-Fa-f-]+)\).*/\1/')"

if [ -z "$DEVICE_ID" ]; then
  warn "No physical iPhone detected. Falling back to an EAS development build."
  warn "Connect the phone with Developer Mode enabled, or run: ./scripts/build_ios_dev.sh eas"
  exit 1
fi

echo "  target device: $DEVICE_ID"
npx expo run:ios --device "$DEVICE_ID"

cat <<'DONE'

──────────────────────────────────────────────────────────────
  Build complete.

  Next steps:
    1. Start Metro:            npx expo start --dev-client
    2. Start the hub on this Mac, then open it on the laptop viewer.
    3. On the phone, tap Calibrate while holding the phone at the
       laptop's position. ARKit's world is anchored at that pose.
    4. Watch the phone overlay: "ARKit ● tracking" means the pose
       is live. "limited" usually means slow motion or few features,
       so move the phone around to let ARKit map the room.

  ARKit cannot run in Expo Go. Always launch through the dev client.
──────────────────────────────────────────────────────────────
DONE