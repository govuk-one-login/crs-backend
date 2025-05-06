export default {
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "results", outputName: "report.xml" }],
  ],
  collectCoverage: true,
  coveragePathIgnorePatterns: ["/testUtils/", "/node-modules/"],
  preset: "ts-jest",
  testMatch: ["**/*.test.ts"],
  testEnvironment: "node",
  clearMocks: true,
};

process.env.POWERTOOLS_DEV = "true";
process.env.AWS_LAMBDA_LOG_LEVEL = "DEBUG";
