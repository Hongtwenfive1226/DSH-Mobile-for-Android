module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // 这些依赖以 ESM 发布，必须让 babel 转换，否则 jest 会报 "Unexpected token 'export'"
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|@react-native-community|@react-native-documents|@react-native-async-storage|@dr\\.pogodin|react-native-svg|react-native-safe-area-context)/)',
  ],
};
