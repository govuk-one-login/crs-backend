import { writeFileSync } from "fs";
import { SignJWT } from 'jose';
import { generateKeyPair } from 'jose';
import cbor from 'cbor';
import { sign } from 'cose-js';
import * as COSE from 'cose-js';

let allowedBytes = [[0x00, 0x01], [0x00, 0x00]];
let numberOfRecords = 10;

let bitStringResponse = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    id: "https://crs.account.gov.uk/b/A671FED3E9AD",
    type: ["VerifiableCredential", "BitstringStatusListCredential"],
    issuer: "did:example:12345",
    validFrom: "2025-01-05T14:00:00Z",
    validUntil: "2021-04-05T02:00:00Z",
    credentialSubject: {
        id: "https://crs.account.gov.uk/b/A671FED3E9AD",
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
    iat: 1686920170,
    status_list: {
        bits: 2,
        lst: "eNrbuRgAAhcBXQ"
    },
    sub: "https://crs.account.gov.uk/t/3B0F3BD087A7",
    ttl: 43200
}

compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'gzip').then
    (
        function (compressedString) {
            bitStringResponse.credentialSubject.encodedList = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
            encodeMessageJWT(tokenPayload).then
                (
                    function (encodedMessage) {
                        createFile("BitStringStatusListResponseJWT", encodedMessage);
                    }
                )
        }
    );

compress(generateByteArray(numberOfRecords, allowedBytes).join(""), 'deflate').then
    (
        function (compressedString) {
            tokenPayload.status_list.lst = btoa(String.fromCharCode.apply(null, new Uint8Array(compressedString)));
            encodeMessageCwt(tokenPayload,).then
                (
                    function (encodedMessageCWT) {
                        createFile("TokenStatusListResponseCWT", encodedMessageCWT);
                    }
                )

        }
    );


function generateByteArray(length: number, validValues: number[][]): ArrayBuffer[] {

    if (validValues.length === 0) {
        throw new Error("no valid values provided");
    }

    const result = new Array(length);

    for (var i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * validValues.length);
        result[i] = validValues[randomIndex].join("");
    }
    return result;
}

async function compress(dataToBeCompressed, encoding) {
    const byteArray = new TextEncoder().encode(dataToBeCompressed);
    const cs = new CompressionStream(encoding);
    const writer = cs.writable.getWriter();
    writer.write(byteArray);
    writer.close();
    return new Response(cs.readable).arrayBuffer();
}

function createFile(fileName: string, text) {

    writeFileSync(fileName, text, {
        flag: "w"
    })
}

async function encodeMessageJWT(message: any): Promise<string> {

    //replace with real private key later
    const { privateKey } = await generateKeyPair('ES256');

    // Create the JWT
    const jwt = await new SignJWT(message)
        .setProtectedHeader({
            alg: 'ES256',
            kid: '12',
            typ: 'vc+jwt'
        })
        .sign(privateKey);

    return jwt;
}

// Function to encode the message object into a CWT using COSE
async function encodeMessageCwt(message: any): Promise<string> {

    const headers = {
        p: {
            alg: 'ES256', // Example content type value (if needed)
        },
        u: {
            kid: '11',
            content_type: "application/statuslist+cwt"
        }
    };

    const signer = {
        key: {
            d: Buffer.from('6c1382765aec5358f117733d281c1c7bdc39884d04a45a1e6c67c858bc206c19', 'hex')
        }
    };

    const signedCWT = await sign.create(headers, message, signer);

    const cwt = signedCWT.toString('base64url');

    return cwt;
}
