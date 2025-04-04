import { writeFileSync } from "fs";
import { SignJWT, generateKeyPair } from 'jose';
import { sign } from 'cose-js';
import cbor from 'cbor';
import { generateByteArray } from '../../../src/mockData/generateMockStatusList.js';

// Mock external dependencies for testing
jest.mock('fs');
jest.mock('jose');
jest.mock('cose-js');
jest.mock('cbor');

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
}

// Unit Tests
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
    expect(() => generateByteArray(numberOfRecords, [])).toThrowError('no valid values provided');
  });

  it('should write the encoded JWT to a file', async () => {
    const mockEncodedJWT = 'mock-jwt-token';
    (encodeMessageJWT as jest.Mock).mockResolvedValue(mockEncodedJWT); 

    await compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'gzip').then(
      async function (compressedString) {
        bitStringPayload.credentialSubject.encodedList = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
        await encodeMessageJWT(bitStringPayload).then(
          function (encodedMessage) {
            createFile("A671FED3E9AD", encodedMessage);
          }
        )
      }
    );

    expect(writeFileSync).toHaveBeenCalledWith('A671FED3E9AD', mockEncodedJWT, { flag: 'w' });
  });

  it('should write the encoded CWT to a file', async () => {
    const mockEncodedCWT = 'mock-cwt-token';
    (encodeMessageCwt as jest.Mock).mockResolvedValue(mockEncodedCWT);

    await compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'deflate').then(
      async function (compressedString) {
        tokenPayload.status_list.lst = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
        await encodeMessageCwt(tokenPayload).then(
          function (encodedMessageCWT) {
            createFile("3B0F3BD087A7", encodedMessageCWT);
          }
        )
      }
    );

    expect(writeFileSync).toHaveBeenCalledWith('3B0F3BD087A7', mockEncodedCWT, { flag: 'w' });
  });

  it('should encode a JWT with the correct payload and headers', async () => {
    const { privateKey } = await generateKeyPair('ES256'); 
    const mockJWT = 'mock-jwt';
    (SignJWT as jest.Mock).mockReturnValue({
      setProtectedHeader: jest.fn().mockReturnThis(),
      sign: jest.fn().mockResolvedValue(mockJWT),
    });

    const encodedJWT = await encodeMessageJWT(bitStringPayload);

    expect(SignJWT).toHaveBeenCalledWith(bitStringPayload);
    expect(encodedJWT).toBe(mockJWT);
  });

  it('should encode a CWT with the correct payload and headers', async () => {
    const mockCWT = 'mock-cwt';
    (sign.create as jest.Mock).mockResolvedValue(Buffer.from(mockCWT, 'base64url'));

    const encodedCWT = await encodeMessageCwt(tokenPayload);

    expect(cbor.encode).toHaveBeenCalledWith(tokenPayload);
    expect(sign.create).toHaveBeenCalledWith(
      {
        p: {
          alg: 'ES256',
          kid: '11',
          content_type: 'application/statuslist+cwt',
        },
      },
      expect.any(Buffer), // Check if CBOR encoded payload is passed
      expect.any(Object)  // Check if signer object is passed
    );
    expect(encodedCWT).toBe(mockCWT);
  });
});
