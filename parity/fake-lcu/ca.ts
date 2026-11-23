import crypto from "node:crypto";

export interface FakePki {
  caPem: string;
  leafPem: string;
  leafKeyPem: string;
}

const DAY_MS = 86_400_000;

const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : body.length < 0x100
        ? Buffer.from([0x81, body.length])
        : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
const octets = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), value);
const boolTrue = tlv(0x01, Buffer.from([0xff]));
/** A positive DER INTEGER in its minimal form: no leading zero byte, one only to keep the sign bit clear. */
export function integer(value: Buffer) {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  const bytes = value.subarray(start);
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** 16 random bytes, never zero, so the serial is a positive integer. */
function serialNumber() {
  const bytes = crypto.randomBytes(16);
  if (bytes.every((b) => b === 0)) bytes[15] = 1;
  return integer(bytes);
}

function oid(dotted: string) {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const OID = {
  ecdsaSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

const name = (commonName: string) =>
  sequence(
    set(sequence(oid(OID.organization), tlv(0x0c, Buffer.from("Better Mayhem Tracker parity")))),
    set(sequence(oid(OID.commonName), tlv(0x0c, Buffer.from(commonName)))),
  );

const utcTime = (date: Date) => {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return tlv(0x17, Buffer.from(text));
};

const extension = (id: string, value: Buffer, critical = false) =>
  sequence(oid(id), ...(critical ? [boolTrue] : []), octets(value));

const signatureAlgorithm = () => sequence(oid(OID.ecdsaSha256));

// The point is the last 65 bytes of a P-256 SubjectPublicKeyInfo
const keyId = (publicKey: crypto.KeyObject) =>
  crypto
    .createHash("sha1")
    .update(publicKey.export({ type: "spki", format: "der" }).subarray(-65))
    .digest();

interface CertificateInput {
  subject: string;
  issuer: string;
  publicKey: crypto.KeyObject;
  issuerKey: crypto.KeyObject;
  issuerPublicKey: crypto.KeyObject;
  isCa: boolean;
  now: Date;
}

function certificate(input: CertificateInput): string {
  const { subject, issuer, publicKey, issuerKey, issuerPublicKey, isCa, now } = input;
  const extensions = [
    extension(OID.basicConstraints, sequence(...(isCa ? [boolTrue] : [])), true),
    extension(
      OID.keyUsage,
      isCa ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7),
      true,
    ),
    extension(OID.subjectKeyId, octets(keyId(publicKey))),
    extension(OID.authorityKeyId, sequence(tlv(0x80, keyId(issuerPublicKey)))),
    ...(isCa
      ? []
      : [
          extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))),
          extension(
            OID.subjectAltName,
            sequence(tlv(0x82, Buffer.from("localhost")), tlv(0x87, Buffer.from([127, 0, 0, 1]))),
          ),
        ]),
  ];

  const toBeSigned = sequence(
    tlv(0xa0, integer(Buffer.from([2]))),
    serialNumber(),
    signatureAlgorithm(),
    name(issuer),
    sequence(
      utcTime(new Date(now.getTime() - DAY_MS)),
      utcTime(new Date(now.getTime() + 7 * DAY_MS)),
    ),
    name(subject),
    Buffer.from(publicKey.export({ type: "spki", format: "der" })),
    tlv(0xa3, sequence(...extensions)),
  );
  const signature = crypto.sign("sha256", toBeSigned, issuerKey);
  const der = sequence(toBeSigned, signatureAlgorithm(), bitString(signature));
  const lines = der.toString("base64").match(/.{1,64}/g)!;
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * A throwaway CA and a leaf for 127.0.0.1 and localhost, made at run time. Nothing about
 * them is fixed, so no release build can contain them. The CA's name says what it is, and
 * it is never Riot's.
 */
export function generatePki(now: Date = new Date()): FakePki {
  const ca = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leaf = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caName = "Parity fake League CA (not Riot)";
  return {
    caPem: certificate({
      subject: caName,
      issuer: caName,
      publicKey: ca.publicKey,
      issuerKey: ca.privateKey,
      issuerPublicKey: ca.publicKey,
      isCa: true,
      now,
    }),
    leafPem: certificate({
      subject: "parity-fake-lcu",
      issuer: caName,
      publicKey: leaf.publicKey,
      issuerKey: ca.privateKey,
      issuerPublicKey: ca.publicKey,
      isCa: false,
      now,
    }),
    leafKeyPem: leaf.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}
