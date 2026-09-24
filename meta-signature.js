import crypto from "node:crypto";

export function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody)) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signature || "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
