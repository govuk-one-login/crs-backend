export default {
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "results", outputName: "report.xml" }],
  ],
  collectCoverage: true,
  coveragePathIgnorePatterns: ["/testUtils/", "/node-modules/"],
  preset: "ts-jest",  testMatch: ["**/*.test.ts"],
  testEnvironment: "node",
  clearMocks: true,
};
