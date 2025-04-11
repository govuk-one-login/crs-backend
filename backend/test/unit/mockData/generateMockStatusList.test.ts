import {
  generateByteArray,
  compress,
} from "../../../src/mockData/generateMockStatusList";
import { describe, expect } from "@jest/globals";

let allowedBytes = [
  [0x00, 0x01],
  [0x00, 0x00],
];
let numberOfRecords = 10;

describe("Bitstring and Token Encoding Functions", () => {
  it("should generate a byte array of the correct length", () => {
    const byteArray = generateByteArray(numberOfRecords, allowedBytes);
    expect(byteArray.length).toBe(numberOfRecords);
  });
  it("should throw an error if no valid values are provided for byte array generation", () => {
    expect(() => generateByteArray(numberOfRecords, [])).toThrow(
      "no valid values provided",
    );
  });
});

describe("compressData", () => {
  it("should compress data using deflate", async () => {
    const inputData = "Another test string for deflate compression.";
    const compressedData = await compress(inputData, "deflate");

    expect(compressedData).toBeInstanceOf(ArrayBuffer);
    expect(compressedData.byteLength).toBeGreaterThan(0);
  });

  it("should compress data using gzip", async () => {
    const inputData = "Another test string for gzip compression.";
    const compressedData = await compress(inputData, "gzip");

    expect(compressedData).toBeInstanceOf(ArrayBuffer);
    expect(compressedData.byteLength).toBeGreaterThan(0);
  });
});
