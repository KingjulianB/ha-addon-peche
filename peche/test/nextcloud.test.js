import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Faux serveur WebDAV local : on vérifie le comportement réel des requêtes
// HTTP (méthode, chemin encodé, en-tête d'authentification) sans dépendre
// d'un vrai Nextcloud ni ajouter de dépendance de mock HTTP.
const receivedRequests = [];
let nextResponses = [];

const server = createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    receivedRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(body) });
    const next = nextResponses.shift() || { status: 500 };
    res.writeHead(next.status, next.headers || {});
    res.end(next.body || "");
  });
});

let baseUrl;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.NEXTCLOUD_URL = baseUrl;
  process.env.NEXTCLOUD_USER = "user-test";
  process.env.NEXTCLOUD_PASSWORD = "pass-test";
  process.env.NEXTCLOUD_FOLDER = "CarnetTest";
});
after(() => server.close());
beforeEach(() => { receivedRequests.length = 0; nextResponses = []; });

const { nextcloudConfigured, uploadPhoto, downloadPhoto } = await import("../server/nextcloud.js");

describe("nextcloudConfigured", () => {
  test("vrai quand URL/utilisateur/mot de passe sont renseignés", () => {
    assert.equal(nextcloudConfigured(), true);
  });
});

describe("uploadPhoto", () => {
  test("crée le dossier racine + sous-dossier puis dépose le fichier, avec l'authentification Basic attendue", async () => {
    nextResponses = [
      { status: 201 }, // MKCOL dossier racine
      { status: 201 }, // MKCOL sous-dossier entreprise
      { status: 201 }, // PUT fichier
    ];
    const buf = Buffer.from("donnée-photo");
    const remotePath = await uploadPhoto("chat.jpg", buf, "image/jpeg", "ent-1");

    assert.equal(remotePath, "CarnetTest/ent-1/chat.jpg");
    assert.equal(receivedRequests.length, 3);
    assert.equal(receivedRequests[0].method, "MKCOL");
    assert.equal(receivedRequests[0].url, "/remote.php/dav/files/user-test/CarnetTest");
    assert.equal(receivedRequests[1].method, "MKCOL");
    assert.equal(receivedRequests[1].url, "/remote.php/dav/files/user-test/CarnetTest/ent-1");
    assert.equal(receivedRequests[2].method, "PUT");
    assert.equal(receivedRequests[2].url, "/remote.php/dav/files/user-test/CarnetTest/ent-1/chat.jpg");
    assert.ok(receivedRequests[2].body.equals(buf));

    const expectedAuth = "Basic " + Buffer.from("user-test:pass-test").toString("base64");
    for (const r of receivedRequests) assert.equal(r.auth, expectedAuth);
  });

  test("un dossier déjà existant (405) n'est pas une erreur", async () => {
    nextResponses = [{ status: 405 }, { status: 405 }, { status: 201 }];
    const remotePath = await uploadPhoto("autre.jpg", Buffer.from("x"), "image/jpeg", "ent-2");
    assert.equal(remotePath, "CarnetTest/ent-2/autre.jpg");
  });

  test("échec MKCOL inattendu → erreur explicite, rien n'est envoyé", async () => {
    nextResponses = [{ status: 500 }];
    await assert.rejects(
      () => uploadPhoto("x.jpg", Buffer.from("x"), "image/jpeg", "ent-3-erreur"),
      /Nextcloud injoignable/i
    );
    assert.equal(receivedRequests.length, 1); // pas de PUT tenté après l'échec MKCOL
  });

  test("échec du dépôt (ni 201 ni 204) → erreur explicite avec le code HTTP", async () => {
    nextResponses = [{ status: 201 }, { status: 201 }, { status: 507 }];
    await assert.rejects(
      () => uploadPhoto("x.jpg", Buffer.from("x"), "image/jpeg", "ent-4-erreur-put"),
      /Envoi Nextcloud échoué \(507\)/
    );
  });

  test("un même sous-dossier n'est vérifié/créé qu'une seule fois (cache)", async () => {
    nextResponses = [{ status: 201 }, { status: 201 }, { status: 201 }];
    await uploadPhoto("premier.jpg", Buffer.from("x"), "image/jpeg", "ent-cache");
    receivedRequests.length = 0;
    nextResponses = [{ status: 201 }]; // seul le PUT est attendu cette fois
    await uploadPhoto("second.jpg", Buffer.from("x"), "image/jpeg", "ent-cache");
    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].method, "PUT");
  });
});

describe("downloadPhoto", () => {
  test("récupère le contenu binaire et le type MIME", async () => {
    nextResponses = [{ status: 200, headers: { "content-type": "image/png" }, body: Buffer.from("PNGDATA") }];
    const { buffer, mime } = await downloadPhoto("CarnetTest/ent-1/chat.jpg");
    assert.equal(mime, "image/png");
    assert.ok(buffer.equals(Buffer.from("PNGDATA")));
    assert.equal(receivedRequests[0].method, "GET");
    assert.equal(receivedRequests[0].url, "/remote.php/dav/files/user-test/CarnetTest/ent-1/chat.jpg");
  });

  test("fichier introuvable → erreur explicite avec le code HTTP", async () => {
    nextResponses = [{ status: 404 }];
    await assert.rejects(() => downloadPhoto("CarnetTest/inconnu.jpg"), /Lecture Nextcloud échouée \(404\)/);
  });
});
