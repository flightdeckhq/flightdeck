// Minimal RFC 4122 §4.3 name-based UUID (version 5, SHA-1). No npm
// dependency -- the plugin ships zero runtime deps. Byte 6 upper nibble
// carries the version; byte 8 top two bits carry the variant marker.
// Getting either wrong produces a plausible-looking but non-conforming
// UUID, so tests/uuid5.test.mjs asserts against the RFC 4122 Appendix B
// vectors.

import { createHash } from "node:crypto";

// RFC 4122 Appendix C namespace identifiers.
export const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError(`invalid UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(buf) {
  const h = buf.toString("hex");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20, 32)
  );
}

export function uuid5(namespace, name) {
  const ns = uuidToBytes(namespace);
  const bytes = Buffer.from(
    createHash("sha1")
      .update(ns)
      .update(Buffer.from(name, "utf8"))
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
