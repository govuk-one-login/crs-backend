import { ESM_TS_TRANSFORM_PATTERN } from "ts-jest";

export default {
  reporters: [
    "default",
    ["jest-junit", { outputDirectory: "results", outputName: "report.xml" }],
  ],
  collectCoverageFrom: [
    "./**/*.ts",
    "!./**/types/*.ts",
    "!./test/**/*.ts",
    "!./jest.config.ts",
  ],
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageProvider: "ts-jest",
  testMatch: ["**/*.test.ts"],
  testEnvironment: "node",
  clearMocks: true,
  transformIgnorePatterns: ["/node_modules/(?!cbor2).+\\.js$"],
};
