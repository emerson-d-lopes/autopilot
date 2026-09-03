#!/usr/bin/env node
// Generates the RSA key that pins the unpacked extension's ID.
//
// Chrome derives an unpacked extension's ID from its directory path unless the
// manifest carries a "key" field. A path-derived ID changes whenever the folder
// moves, which breaks the native messaging host manifest's allowed_origins.
// Pinning the key makes the ID stable across machines and checkouts.

import { generateKeyPairSync, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_PATH = join(ROOT, '.keys', 'extension.pem');
const MANIFEST_PATH = join(ROOT, 'extension', 'manifest.json');
const ID_PATH = join(ROOT, '.keys', 'extension-id.txt');

/**
 * Chrome maps the first 16 bytes of the SHA-256 of the DER SPKI public key into
 * the alphabet a-p, one character per hex nibble.
 */
export function extensionIdFromDer(der) {
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    return readFileSync(KEY_PATH, 'utf8');
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, privateKey, { mode: 0o600 });
  return privateKey;
}

async function main() {
  const { createPrivateKey, createPublicKey } = await import('node:crypto');
  const pem = loadOrCreateKey();
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' });
  const id = extensionIdFromDer(der);
  const keyB64 = der.toString('base64');

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.key = keyB64;
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(ID_PATH, id + '\n');

  console.log('extension id: ' + id);
  console.log('manifest key written to extension/manifest.json');
  console.log('private key at .keys/extension.pem (git-ignored, do not share)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
