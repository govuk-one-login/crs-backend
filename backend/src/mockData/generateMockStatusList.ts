import { writeFileSync } from "fs";
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
}

//Generates byte array, compresses with gzip and encodes into base 64, then encodes entire response into JWT
generateBitStringJWTFile();

//Generates byte array, compresses with deflate and encodes into base 64, then encodes entire response into CWT
generateTokenCWTFile();


function generateTokenCWTFile() {
    compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'deflate').then(
        function (compressedString) {
            console.log(compressedString);
            tokenPayload.status_list.lst = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
            encodeMessageCwt(tokenPayload).then(
                function (encodedMessageCWT) {
                    createFile("3B0F3BD087A7", encodedMessageCWT);
                }
            );
        }
    );
}

function generateBitStringJWTFile() {
    compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'gzip').then(
        function (compressedString) {
            bitStringPayload.credentialSubject.encodedList = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
            encodeMessageJWT(bitStringPayload).then(
                function (encodedMessage) {
                    createFile("A671FED3E9AD", encodedMessage);
                }
            );
        }
    );
}

export function generateByteArray(length: number, validValues: number[][]): ArrayBuffer[] {

    if (validValues.length === 0) {
        throw new Error("no valid values provided");
    }

    const result = new Array(length);

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * validValues.length);
        result[i] = validValues[randomIndex].join("");
    }
    return result;
}

export async function compress(dataToBeCompressed, compresstionType) {
    const byteArray = new TextEncoder().encode(dataToBeCompressed);
    const cs = new CompressionStream(compresstionType);
    const writer = cs.writable.getWriter();
    writer.write(byteArray);
    writer.close();
    return new Response(cs.readable).arrayBuffer();
}

export function createFile(fileName: string, text) {

    writeFileSync(fileName, text, {
        flag: "w"
    })
}

// Function to encode the bitstring response object into a JWT using JOSE
export async function encodeMessageJWT(message: any): Promise<string> {

    const { privateKey } = await generateKeyPair('ES256');
    const jwt = await new SignJWT(message)
        .setProtectedHeader({
            alg: 'ES256',
            kid: '12',
            typ: 'vc+jwt'
        })
        .sign(privateKey);

    return jwt;
}

// Function to encode the token response object into a CWT using COSE
export async function encodeMessageCwt(message: any): Promise<string> {

    const cborPayload = cbor.encode(message);
    const headers = {
        p: {
            alg: 'ES256',
            kid: '11',
            content_type: "application/statuslist+cwt"
        }
    };

    const signer = {
        key: {
            d: Buffer.from('6c1382765aec5358f117733d281c1c7bdc39884d04a45a1e6c67c858bc206c19', 'hex'),
            x: Buffer.from('143329cce7868e416927599cf65a34f3ce2ffda55a7eca69ed8919a394d42f0f', 'hex'),
            y: Buffer.from('60f7f1a780d8a783bfb7a2dd6b2796e8128dbbcef9d3d168db9529971a36e7b9', 'hex'),
        }
    };

    const signedCWT = await sign.create(headers, cborPayload, signer);
    const cwt = signedCWT.toString('base64url');

    return cwt;
}
