/* eslint-env jest */
// App 冒烟测试要在 jest 环境里挂载整个应用，需要给原生模块提供替身。
// 这些替身只影响测试，不影响真机运行。

jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(async () => []),
  keepLocalCopy: jest.fn(async () => []),
  types: { allFiles: '*/*' },
  isErrorWithCode: jest.fn(() => false),
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/tmp',
  readFile: jest.fn(async () => ''),
  writeFile: jest.fn(async () => undefined),
}));

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: any) => React.createElement(View, props, props.children);
  return { __esModule: true, default: Mock, Svg: Mock, Path: Mock };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest'),
);
