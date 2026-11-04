import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { PortalConnection } from "@tenderly/shared";
import type { StoredPortalConnection } from "./db.js";

/**
 * The optional authenticated eTenders connection (Beta).
 *
 * There is no public eTenders API, so this module guards the credentials a
 * user entrusts to us for portal messaging. The password is stored
 * AES-256-GCM encrypted under TENDERLY_PORTAL_KEY; without that key the
 * feature is disabled everywhere and the routes say so.
 *
 * Honesty rails this module enforces:
 * - The password is never returned, never logged, and never stored in clear.
 * - Connection status starts "untested" and moves to "ok"/"failed" only
 *   after a real attempt against the portal — saving credentials is not
 *   evidence that they work.
 */

/** The feature is off unless the server operator set an encryption key. */
export function portalConnectionEnabled() {
  return Boolean(process.env.TENDERLY_PORTAL_KEY?.trim());
}

/**
 * The raw key material. Any non-empty string is accepted and stretched to the
 * 32 bytes AES-256 needs with SHA-256, so operators can supply a passphrase or
 * a hex key interchangeably.
 */
function keyMaterial(): Buffer | null {
  const configured = process.env.TENDERLY_PORTAL_KEY?.trim();
  if (!configured) return null;
  return createHash("sha256").update(configured, "utf8").digest();
}

/** Encrypts a portal password as `v1.<iv>.<tag>.<ciphertext>`, base64 fields. */
export function encryptPortalPassword(password: string): string {
  const key = keyMaterial();
  if (!key) throw new Error("PORTAL_DISABLED");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

/** Reverses encryptPortalPassword. Throws on tampering, a wrong key, or a foreign format. */
export function decryptPortalPassword(envelope: string): string {
  const key = keyMaterial();
  if (!key) throw new Error("PORTAL_DISABLED");
  const [version, iv, tag, ciphertext] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("PORTAL_CREDENTIAL_UNREADABLE");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/**
 * A stored connection as the wire sees it: never the password, and the email
 * masked — the full address is the user's own, but the connection card is
 * often read over a shoulder.
 */
export function serializePortalConnection(record: StoredPortalConnection | null): PortalConnection {
  if (!portalConnectionEnabled()) {
    return { connected: false, email: null, status: "disabled", verifiedAt: null, lastSyncAt: null, error: null };
  }
  if (!record) {
    return { connected: false, email: null, status: "untested", verifiedAt: null, lastSyncAt: null, error: null };
  }
  const [local, domain] = record.email.split("@");
  const masked = domain ? `${local.slice(0, 2)}***@${domain}` : "***";
  return {
    connected: true,
    email: masked,
    status: record.status,
    verifiedAt: record.verifiedAt,
    lastSyncAt: record.lastSyncAt,
    error: record.error,
  };
}
