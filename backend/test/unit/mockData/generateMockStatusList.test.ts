import { writeFileSync } from "fs";
import { generateByteArray, compress, encodeMessageCwt, encodeMessageJWT, createFile } from '../../../src/mockData/generateMockStatusList';
import { describe, test, expect } from '@jest/globals'
import { SignJWT, generateKeyPair } from 'jose';
import { sign } from 'cose-js';
import cbor from 'cbor';

let allowedBytes = [[0x00, 0x01], [0x00, 0x00]];
let numberOfRecords = 10;
let bitStringPayload = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
    type: ["VerifiableCredential", "BitstringStatusListCredential"],
    issuer: "did:example:12345",
    validFrom: "2025-01-05T14:00:00Z",
    validUntil: "2030-04-05T02:00:00Z",
    credentialSubject: {
        id: "https://douglast-backend.crs.dev.account.gov.uk/b/A671FED3E9AD",
        type: "BitstringStatusList",
        statusSize: 2,
        statusPurpose: "message",
        statusMessage: [
            { "status": "0x0", "message": "VALID" },
            { "status": "0x1", "message": "INVALID" }
        ],
        encodedList: ""
    }
};
let tokenPayload = {
    exp: 2291720170,
    iat: 1735988295,
    status_list: {
        bits: 2,
        lst: ""
    },
    sub: "https://douglast-backend.crs.dev.account.gov.uk/t/3B0F3BD087A7",
    ttl: 43200
};

describe('Bitstring and Token Encoding Functions', () => {
    beforeEach(() => {
        // Reset mocks before each test
        jest.clearAllMocks();
    });
    it('should generate a byte array of the correct length', () => {
        const byteArray = generateByteArray(numberOfRecords, allowedBytes);
        expect(byteArray.length).toBe(numberOfRecords);
    });
    it('should throw an error if no valid values are provided for byte array generation', () => {
        expect(() => generateByteArray(numberOfRecords, [])).toThrow('no valid values provided');
    });
});

describe('compressData', () => {
    it('should compress data using deflate', async () => {
        const inputData = 'Another test string for deflate compression.';
        const compressedData = await compress(inputData, 'deflate');
    
        // Assertions:
        expect(compressedData).toBeInstanceOf(ArrayBuffer);
        expect(compressedData.byteLength).toBeGreaterThan(0);

    });

    it('should compress data using gzip', async () => {
        const inputData = 'Another test string for gzip compression.';
        const compressedData = await compress(inputData, 'gzip');
    
        // Assertions:
        expect(compressedData).toBeInstanceOf(ArrayBuffer);
        expect(compressedData.byteLength).toBeGreaterThan(0);

    });
});