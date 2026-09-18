// ============================================================
//  Envoi d'emails (vérification d'inscription).
//
//  Fonctionne dès que des identifiants SMTP sont fournis via les
//  options de l'add-on. Sans SMTP configuré, l'envoi est "simulé" :
//  le lien de vérification est journalisé et reste récupérable par
//  le super-admin, pour ne jamais bloquer les inscriptions.
//
//  Variables d'environnement (options de l'add-on) :
//    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
//    SMTP_FROM   (ex: "Fisher Link <inscription@peche.arxdomotica.com>")
//    APP_BASE_URL (ex: https://peche.arxdomotica.com) — pour les liens
// ============================================================
import nodemailer from "nodemailer";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, "logo-email.png");

const HOST = process.env.SMTP_HOST || "";
const PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const USER = process.env.SMTP_USER || "";
const PASSWORD = process.env.SMTP_PASSWORD || "";
const FROM = process.env.SMTP_FROM || "Fisher Link <no-reply@fisherlink.local>";
const BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");

export function smtpConfigured() {
  return Boolean(HOST && USER && PASSWORD);
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!smtpConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: HOST, port: PORT, secure: PORT === 465,
    auth: { user: USER, pass: PASSWORD },
  });
  return transporter;
}

export function verifyUrl(token) {
  const base = BASE_URL || "";
  return `${base}/verifier?token=${encodeURIComponent(token)}`;
}

/**
 * Envoie l'email de vérification. Renvoie { sent: bool, url }.
 * Si SMTP non configuré : { sent:false, url } — le lien est utilisable
 * manuellement par le super-admin.
 */
export async function sendVerification(email, nomEntreprise, token) {
  const url = verifyUrl(token);
  if (!smtpConfigured()) {
    console.log(`[MAIL simulé] Vérification pour ${email} : ${url}`);
    return { sent: false, url };
  }
  try {
    const t = getTransporter();
    // Logo intégré (CID) : s'affiche même sans connexion / images distantes bloquées
    const attachments = [];
    let logoTag = "";
    if (existsSync(LOGO_PATH)) {
      attachments.push({ filename: "fisher-link.png", path: LOGO_PATH, cid: "logofl" });
      logoTag = `<img src="cid:logofl" width="72" height="72" alt="Fisher Link" style="display:block;margin:0 auto 12px;border-radius:14px">`;
    }
    const html = `
      <div style="max-width:480px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#1a1d1a"><meta charset="utf-8">
        <div style="text-align:center;padding:24px 0 8px">
          ${logoTag}
          <div style="font-size:22px;font-weight:700;color:#12395f">Fisher Link</div>
          <div style="font-size:13px;color:#888">Journal de bord & gestion de pêche</div>
        </div>
        <div style="background:#f6f4ef;border-radius:8px;padding:24px;margin-top:12px">
          <p>Bonjour,</p>
          <p>Vous avez créé l'entreprise <b>${escapeHtml(nomEntreprise)}</b> sur Fisher Link.</p>
          <p>Pour activer votre compte, confirmez votre adresse email :</p>
          <p style="text-align:center;margin:24px 0">
            <a href="${url}" style="display:inline-block;background:#0d5c4a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600">Vérifier mon compte</a>
          </p>
          <p style="font-size:12px;color:#888">Ou copiez ce lien dans votre navigateur :<br><span style="word-break:break-all">${url}</span></p>
        </div>
        <p style="font-size:11px;color:#aaa;text-align:center;margin-top:16px">Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.</p>
      </div>`;
    await t.sendMail({
      from: FROM, to: email,
      subject: "Fisher Link — Confirmez votre inscription",
      text: `Bonjour,\n\nVous avez créé l'entreprise "${nomEntreprise}" sur Fisher Link.\n`
          + `Confirmez votre adresse en ouvrant ce lien :\n${url}\n\n`
          + `Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.`,
      html, attachments,
      encoding: "utf-8",
      textEncoding: "base64",
    });
    return { sent: true, url };
  } catch (e) {
    console.warn("Envoi email échoué, lien disponible manuellement :", e.message);
    return { sent: false, url, error: e.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
