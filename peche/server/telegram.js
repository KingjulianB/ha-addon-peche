// ============================================================
//  Intégration Telegram — un pêcheur envoie ses photos de capture
//  au bot pendant la sortie ; elles apparaissent ensuite comme
//  suggestions dans le formulaire de saisie une fois à quai (voir
//  §TELEGRAM dans server/index.js pour le webhook et le rattachement).
//
//  Un seul bot pour toute la plateforme (multi-tenant) : l'isolation
//  se fait via la table telegram_links (chat_id -> user/entreprise),
//  pas via un bot par entreprise.
//
//  Variables d'environnement :
//    TELEGRAM_BOT_TOKEN      token du bot (@BotFather)
//    TELEGRAM_BOT_USERNAME   pseudo du bot sans @ (pour le lien t.me
//                            affiché dans l'appli)
//    TELEGRAM_WEBHOOK_SECRET secret partagé, vérifié sur chaque appel
//                            webhook via l'en-tête
//                            X-Telegram-Bot-Api-Secret-Token
// ============================================================

import { createHmac, timingSafeEqual } from "node:crypto";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "";
export const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
// Surchageable en test pour pointer vers un faux serveur HTTP local,
// comme NEXTCLOUD_URL dans nextcloud.js — jamais changé en production.
const API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const API = `${API_BASE}/bot${BOT_TOKEN}`;

export function telegramConfigured() {
  return Boolean(BOT_TOKEN);
}
export function telegramBotUsername() {
  return BOT_USERNAME;
}

/** Enregistre l'URL de webhook auprès de Telegram (à faire une fois par déploiement). */
export async function setWebhook(url) {
  const res = await fetch(`${API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, secret_token: WEBHOOK_SECRET || undefined }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error("setWebhook Telegram : " + data.description);
  return data;
}

/**
 * Envoi best-effort d'un message texte (accusé de réception au pêcheur).
 * @param {object} [extra] - champs additionnels de l'API sendMessage, ex.
 *   { reply_markup: { inline_keyboard: [[{ text, web_app: { url } }]] } }
 *   pour proposer le bouton d'ouverture de la Mini App photo.
 */
export async function sendMessage(chatId, text, extra) {
  if (!telegramConfigured()) return;
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
  } catch {
    // Un accusé de réception raté ne doit jamais faire échouer le webhook.
  }
}

/**
 * Vérifie la signature d'un `initData` reçu d'une Mini App Telegram
 * (algorithme officiel : https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * Rejette aussi un initData trop ancien (au-delà de 24h) pour limiter le
 * risque de rejeu si une valeur fuite (ex: logs, historique navigateur).
 * @param {string} initData - chaîne brute Telegram.WebApp.initData
 * @returns {{id:number, first_name?:string, username?:string}} l'utilisateur Telegram authentifié
 */
export function verifyInitData(initData) {
  if (!telegramConfigured()) throw new Error("Telegram non configuré.");
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) throw new Error("initData invalide : hash manquant.");
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("initData invalide : signature incorrecte.");
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    throw new Error("initData expiré, relance la Mini App depuis Telegram.");
  }

  const user = JSON.parse(params.get("user") || "null");
  if (!user || !user.id) throw new Error("initData invalide : utilisateur manquant.");
  return user;
}

/**
 * Télécharge la photo la plus grande d'un message Telegram à partir de
 * son file_id, via getFile puis le point de terminaison fichier du bot.
 * @returns {Promise<{buffer: Buffer, mime: string, ext: string}>}
 */
export async function downloadTelegramPhoto(fileId) {
  const infoRes = await fetch(`${API}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error("getFile Telegram : " + info.description);
  const filePath = info.result.file_path;
  const fileRes = await fetch(`${API_BASE}/file/bot${BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) throw new Error(`Téléchargement photo Telegram échoué (${fileRes.status})`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const rawExt = (filePath.split(".").pop() || "jpg").toLowerCase();
  const ext = rawExt === "jpeg" ? "jpg" : rawExt;
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { buffer, mime, ext };
}
