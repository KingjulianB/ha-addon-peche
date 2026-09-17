import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { Users, defaultEntrepriseId } from "./db.js";

// --- Hachage de mot de passe (scrypt, natif Node, sans dépendance) ---
export function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, "hex");
  return test.length === ref.length && timingSafeEqual(test, ref);
}

// --- Sessions en mémoire (token -> {username, role}) ---
// Suffisant pour un usage à 2 comptes. Les sessions repartent à zéro si
// l'add-on redémarre (il faudra se reconnecter) — acceptable ici.
const sessions = new Map();

export function createSession(user) {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { username: user.username, role: user.role,
    entreprise_id: user.entreprise_id || null, at: Date.now() });
  return token;
}
export function getSession(token) {
  return token ? sessions.get(token) : null;
}
export function destroySession(token) {
  if (token) sessions.delete(token);
}

// --- Création / mise à jour des comptes depuis les options de l'add-on ---
// Appelé au démarrage : garantit qu'un admin et un pêcheur existent, avec les
// mots de passe définis dans la configuration Home Assistant.
export function ensureUsers({ adminPassword, pecheurPassword }) {
  upsertUser("admin", adminPassword, "admin");
  upsertUser("pecheur", pecheurPassword, "pecheur");
}
function upsertUser(username, password, role) {
  if (!password) return;
  const existing = Users.byName.get(username);
  if (existing) {
    // met à jour le mot de passe si l'admin l'a changé dans la config
    Users.updatePassword.run(hashPassword(password), username);
    // rattache le compte à l'entreprise par défaut s'il ne l'est pas encore
    if (!existing.entreprise_id) {
      const ent = defaultEntrepriseId();
      if (ent) Users.setEntreprise.run(ent, username);
    }
  } else {
    Users.insert.run({
      id: randomUUID(), username, password: hashPassword(password), role,
      created_at: Date.now(),
    });
    const ent = defaultEntrepriseId();
    if (ent) Users.setEntreprise.run(ent, username);
  }
}
