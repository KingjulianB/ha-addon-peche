import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

// Faux serveur SMTP minimal (sans dépendance) pour exercer réellement la
// branche "SMTP configuré" de mailer.js — pas seulement le repli simulé.
// N'annonce pas AUTH : nodemailer n'authentifie alors pas, ce qui suffit à
// dérouler tout le protocole jusqu'à l'envoi.
let received = null;
const server = createServer((socket) => {
  let buf = "";
  let dataMode = false;
  let dataBuf = "";
  socket.write("220 fake-smtp ESMTP\r\n");
  socket.on("data", (chunk) => {
    if (dataMode) {
      dataBuf += chunk.toString("utf8");
      if (dataBuf.endsWith("\r\n.\r\n")) {
        dataMode = false;
        received = dataBuf.slice(0, -5);
        socket.write("250 OK message queued\r\n");
      }
      return;
    }
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") socket.write("250 fake-smtp\r\n");
      else if (cmd === "MAIL") socket.write("250 OK\r\n");
      else if (cmd === "RCPT") socket.write("250 OK\r\n");
      else if (cmd === "DATA") { dataMode = true; socket.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
      else if (cmd === "QUIT") { socket.write("221 Bye\r\n"); socket.end(); }
      else socket.write("250 OK\r\n");
    }
  });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(server.address().port);
  process.env.SMTP_USER = "user-test";
  process.env.SMTP_PASSWORD = "pass-test";
  process.env.SMTP_FROM = "Fisher Link <no-reply@test.local>";
  process.env.APP_BASE_URL = "https://peche.example.com";
});
after(() => server.close());

const { smtpConfigured, sendVerification, verifyUrl } = await import("../server/mailer.js");

describe("mailer.js (SMTP configuré, faux serveur local)", () => {
  test("smtpConfigured() est vrai", () => {
    assert.equal(smtpConfigured(), true);
  });

  test("sendVerification() envoie réellement le message via SMTP et renvoie sent:true", async () => {
    const r = await sendVerification("nouveau@test.local", "Ma Pêcherie", "jeton-verif");
    assert.equal(r.sent, true);
    assert.equal(r.url, verifyUrl("jeton-verif"));
    assert.ok(received, "le faux serveur SMTP aurait dû recevoir le contenu du message");
    // Les en-têtes (To, Subject) restent en clair ; le corps est encodé
    // (textEncoding: "base64" dans mailer.js), donc on ne cherche pas le
    // jeton en clair dans le message brut.
    // "Subject" contient un tiret cadratin (non-ASCII) : nodemailer l'encode
    // en RFC 2047 (=?UTF-8?B?...?=), donc on vérifie juste sa présence.
    const headers = received.split(/\r\n\r\n/)[0];
    assert.match(headers, /To: .*nouveau@test\.local/i);
    assert.match(headers, /^Subject: /im);
  });
});
