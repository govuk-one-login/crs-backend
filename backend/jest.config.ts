export default {
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "results", outputName: "report.xml" }],
  ],
  collectCoverage: true,
  coveragePathIgnorePatterns: ["/testUtils/", "/node-modules/"],
  coverageDirectory: "coverage",
  coverageProvider: "babel",
  testMatch: ["**/*.test.ts"],
  testEnvironment: "node",
  clearMocks: true,
};
