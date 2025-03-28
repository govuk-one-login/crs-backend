/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 */

export default {
  reporters: [
    'default',
    ['jest-junit', { outputDirectory: 'results', outputName: 'report.xml' }],
  ],
  // setupFiles: ['dotenv/config'],
  collectCoverageFrom: [
    './**/*.ts',
    '!./**/types/*.ts',
    '!./test/**/*.ts',
    '!./jest.config.ts',
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageProvider: 'babel',
  testMatch: ['**/*.test.ts'],
  testEnvironment: 'node',
  clearMocks: true,
  transformIgnorePatterns: [
    // By default, Babel ignores everything in node_modules when transforming to CommonJS. However, libraries that are
    // ESM-only must still be transformed to work correctly with Jest, unless experimental features are enabled. The
    // below regex ensures that all node modules except those requiring transformation are ignored.
    '/node_modules/(?!mime).+\\.js$',
  ],
}
