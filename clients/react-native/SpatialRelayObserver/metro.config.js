// Metro config for Expo SDK 57
// Resolved by package name (not a nested node_modules path) so the config
// survives any package manager's hoisting layout.
const { getDefaultConfig } = require('@expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
