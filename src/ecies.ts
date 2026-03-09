// ops/gm-server/source/src/ecies.ts
// GM-side ECIES encryption using Node.js built-in crypto.
// Mirrors services/eciesService.ts on the frontend (P-256 + AES-256-GCM).

import { createECDH, createCipheriv, randomBytes } from 'node:crypto';

export interface EciesEncrypted {
  /** 65-byte uncompressed GM ephemeral pubkey (hex) */
  ephemeralPubkey: string;
  /** 12-byte AES-GCM IV (hex) */
  iv: string;
  /** Ciphertext + 16-byte AES-GCM auth tag concatenated (hex) */
  ciphertext: string;
}

/**
 * Encrypt `message` for the player identified by `playerPubkeyHex`.
 * Only the matching private key (held by the player) can decrypt.
 *
 * @param playerPubkeyHex - 65-byte uncompressed P-256 point, hex string.
 * @param message         - Plaintext to encrypt (e.g. "MAFIA", "CIVILIAN").
 */
export function eciesEncrypt(playerPubkeyHex: string, message: string): EciesEncrypted {
  // 1. Generate ephemeral ECDH keypair on P-256 (secp256r1 = prime256v1)
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();

  const ephemeralPubkey = ecdh.getPublicKey('hex', 'uncompressed');

  // 2. ECDH: derive shared secret (X coordinate of shared point, 32 bytes for P-256)
  const playerPubkeyBuf = Buffer.from(playerPubkeyHex, 'hex');
  const sharedSecret = ecdh.computeSecret(playerPubkeyBuf);
  // P-256 X coordinate is always 32 bytes — use directly as AES-256 key
  const aesKey = sharedSecret.slice(0, 32);

  // 3. AES-256-GCM encrypt
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(message, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  return {
    ephemeralPubkey,
    iv: iv.toString('hex'),
    ciphertext: Buffer.concat([encrypted, authTag]).toString('hex'),
  };
}
