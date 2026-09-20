// ============================================================
//  Chiffrement au repos des secrets stockés en base (ex : clé API
//  NEMO d'une pirogue, voir server/index.js §PIROGUES / super-admin).
//
//  AES-256-GCM, node:crypto natif (même logique "zéro dépendance" que
//  le hachage scrypt de auth.js). La clé de chiffrement (32 octets)
//  est générée une seule fois puis persistée dans le même dossier que
//  la base (donc /data en production, sauvegardé par HA comme le
//  reste) : si ce fichier est perdu, les secrets déjà chiffrés
//  deviennent illisibles — pas une perte critique, il suffit de les
//  ressaisir.
// ============================================================
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = process.env.DB_PATH || "./data/peche.db";
const KEY_PATH = join(dirname(DB_PATH), "secret.key");

function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH);
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key);
  return key;
}
const KEY = loadOrCreateKey();

/** Chiffre une chaîne. Renvoie null pour une entrée vide. */
export function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Déchiffre une valeur produite par encryptSecret(). Renvoie null pour une entrée vide. */
export function decryptSecret(stored) {
  if (!stored) return null;
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
