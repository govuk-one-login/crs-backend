export default {
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'results', outputName: 'report.xml' }],
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'ts-jest',
  testMatch: ['**/*.test.ts'],
  testEnvironment: 'node',
  clearMocks: true,
  transformIgnorePatterns: [
    '/node_modules/(?!cbor2).+\\.js$',
  ],
}