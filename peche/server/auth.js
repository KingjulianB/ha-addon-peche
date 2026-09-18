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
  sessions.set(token, { id: user.id, username: user.username, email: user.email,
    role: user.role, entreprise_id: user.entreprise_id || null, at: Date.now() });
  return token;
}
export function getSession(token) {
  return token ? sessions.get(token) : null;
}
export function destroySession(token) {
  if (token) sessions.delete(token);
}

// --- Compte admin de TON entreprise, défini par email dans la config ---
// Remplace l'ancien système admin/pecheur : la connexion se fait par email.
export function ensureAdminAccount({ email, password }) {
  if (!email || !password) return;
  const existing = Users.byEmail.get(email);
  const ent = defaultEntrepriseId();
  if (existing) {
    Users.updatePassword.run(hashPassword(password), existing.username);
    if (!existing.entreprise_id && ent) Users.setEntreprise.run(ent, existing.username);
  } else {
    Users.insert.run({
      id: randomUUID(), username: email, email,
      password: hashPassword(password), role: "admin",
      entreprise_id: ent, email_verifie: 1, verif_token: null, actif: 1,
      created_at: Date.now(),
    });
  }
}

// Crée un nouvel utilisateur (inscription entreprise ou pêcheur invité)
export function createUser({ email, password, role, entreprise_id, verifie }) {
  const token = verifie ? null : randomBytes(20).toString("hex");
  const row = {
    id: randomUUID(), username: email, email,
    password: hashPassword(password), role,
    entreprise_id, email_verifie: verifie ? 1 : 0, verif_token: token,
    actif: 1, created_at: Date.now(),
  };
  Users.insert.run(row);
  return { ...row, verif_token: token };
}
