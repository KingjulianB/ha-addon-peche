import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

// Faux serveur Telegram local (comme test/nextcloud.test.js pour WebDAV) :
// on vérifie le comportement réel des requêtes HTTP sans dépendre de la
// vraie api.telegram.org ni ajouter de dépendance de mock HTTP.
const receivedRequests = [];
let nextResponses = [];

const server = createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    receivedRequests.push({ method: req.method, url: req.url, body: Buffer.concat(body) });
    const next = nextResponses.shift() || { status: 500, json: { ok: false, description: "pas de réponse programmée" } };
    res.writeHead(next.status, next.headers || { "Content-Type": "application/json" });
    res.end(next.body !== undefined ? next.body : JSON.stringify(next.json ?? {}));
  });
});

// telegram.js lit les variables d'environnement au chargement du module (même
// contrainte que nemo.test.js) : tout ce qui les fixe doit s'exécuter avant
// l'import, en code de haut niveau réellement séquentiel — un before() ne
// convient pas ici, son callback ne s'exécute qu'après l'évaluation complète
// de ce fichier (donc après l'import plus bas).
const BOT_TOKEN = "123:test-token";
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.TELEGRAM_BOT_USERNAME = "FisherLinkBot";
process.env.TELEGRAM_WEBHOOK_SECRET = "whsecret";
process.env.TELEGRAM_API_BASE = baseUrl;
after(() => server.close());
beforeEach(() => { receivedRequests.length = 0; nextResponses = []; });

const { telegramConfigured, telegramBotUsername, setWebhook, sendMessage, downloadTelegramPhoto, verifyInitData } =
  await import("../server/telegram.js");

// Construit un initData valide selon l'algorithme officiel Telegram, pour
// vérifier que verifyInitData() l'accepte (et rejette toute altération).
function buildInitData(fields) {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("telegramConfigured / telegramBotUsername", () => {
  test("vrai quand TELEGRAM_BOT_TOKEN est renseigné", () => {
    assert.equal(telegramConfigured(), true);
    assert.equal(telegramBotUsername(), "FisherLinkBot");
  });
});

describe("setWebhook", () => {
  test("appelle setWebhook avec l'URL et le secret", async () => {
    nextResponses = [{ status: 200, json: { ok: true, result: true } }];
    await setWebhook("https://exemple.test/api/telegram/webhook");
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].url, `/bot${BOT_TOKEN}/setWebhook`);
    const sent = JSON.parse(receivedRequests[0].body);
    assert.equal(sent.url, "https://exemple.test/api/telegram/webhook");
    assert.equal(sent.secret_token, "whsecret");
  });

  test("réponse ok:false → erreur explicite avec la description Telegram", async () => {
    nextResponses = [{ status: 200, json: { ok: false, description: "URL invalide" } }];
    await assert.rejects(() => setWebhook("http://pas-https"), /URL invalide/);
  });
});

describe("sendMessage", () => {
  test("envoie le texte et les champs additionnels (reply_markup)", async () => {
    nextResponses = [{ status: 200, json: { ok: true } }];
    await sendMessage("42", "salut", { reply_markup: { inline_keyboard: [] } });
    const sent = JSON.parse(receivedRequests[0].body);
    assert.equal(sent.chat_id, "42");
    assert.equal(sent.text, "salut");
    assert.deepEqual(sent.reply_markup, { inline_keyboard: [] });
  });

  test("un échec réseau/HTTP ne lève jamais (best-effort)", async () => {
    nextResponses = []; // aucune réponse programmée → 500 par défaut, et le fetch réussit quand même (JSON renvoyé)
    await assert.doesNotReject(() => sendMessage("42", "salut"));
  });
});

describe("downloadTelegramPhoto", () => {
  test("récupère le fichier le plus adapté via getFile puis le contenu binaire", async () => {
    nextResponses = [
      { status: 200, json: { ok: true, result: { file_path: "photos/file_1.jpg" } } },
      { status: 200, headers: { "Content-Type": "image/jpeg" }, body: Buffer.from("JPEGDATA") },
    ];
    const { buffer, mime, ext } = await downloadTelegramPhoto("file-id-1");
    assert.ok(buffer.equals(Buffer.from("JPEGDATA")));
    assert.equal(mime, "image/jpeg");
    assert.equal(ext, "jpg");
    assert.equal(receivedRequests[0].url, `/bot${BOT_TOKEN}/getFile?file_id=file-id-1`);
    assert.equal(receivedRequests[1].url, `/file/bot${BOT_TOKEN}/photos/file_1.jpg`);
  });

  test("getFile ok:false → erreur explicite", async () => {
    nextResponses = [{ status: 200, json: { ok: false, description: "file_id invalide" } }];
    await assert.rejects(() => downloadTelegramPhoto("mauvais-id"), /file_id invalide/);
  });
});

describe("verifyInitData", () => {
  test("accepte un initData correctement signé et renvoie l'utilisateur", () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = buildInitData({
      auth_date: String(now),
      user: JSON.stringify({ id: 987654321, first_name: "Ndong" }),
    });
    const user = verifyInitData(initData);
    assert.equal(user.id, 987654321);
    assert.equal(user.first_name, "Ndong");
  });

  test("rejette une signature altérée", () => {
    const now = Math.floor(Date.now() / 1000);
    const initData = buildInitData({ auth_date: String(now), user: JSON.stringify({ id: 1 }) });
    const tampered = initData.replace(/hash=[0-9a-f]+/, "hash=0000000000000000000000000000000000000000000000000000000000000000");
    assert.throws(() => verifyInitData(tampered), /signature incorrecte/);
  });

  test("rejette un hash manquant", () => {
    assert.throws(() => verifyInitData("auth_date=123&user=%7B%7D"), /hash manquant/);
  });

  test("rejette un initData expiré (> 24h)", () => {
    const old = Math.floor(Date.now() / 1000) - 90000;
    const initData = buildInitData({ auth_date: String(old), user: JSON.stringify({ id: 1 }) });
    assert.throws(() => verifyInitData(initData), /expiré/);
  });
});
