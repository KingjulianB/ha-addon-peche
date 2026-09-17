// ============================================================
//  Stockage des photos sur Nextcloud (WebDAV) avec repli local.
//
//  Si Nextcloud est configuré et joignable, les photos y sont déposées.
//  Sinon (non configuré, ou serveur injoignable), la photo est gardée
//  en local dans /data/photos pour ne jamais bloquer une saisie.
//
//  Variables d'environnement (via les options de l'add-on) :
//    NEXTCLOUD_URL       ex: https://cloud.mondomaine.com
//    NEXTCLOUD_USER      identifiant (ou celui du mot de passe d'app)
//    NEXTCLOUD_PASSWORD  mot de passe d'application Nextcloud
//    NEXTCLOUD_FOLDER    dossier cible (défaut: CarnetPeche)
// ============================================================

const URL_BASE = (process.env.NEXTCLOUD_URL || "").replace(/\/+$/, "");
const USER = process.env.NEXTCLOUD_USER || "";
const PASSWORD = process.env.NEXTCLOUD_PASSWORD || "";
const FOLDER = process.env.NEXTCLOUD_FOLDER || "CarnetPeche";

export function nextcloudConfigured() {
  return Boolean(URL_BASE && USER && PASSWORD);
}

function authHeader() {
  return "Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64");
}
function davBase() {
  // Chemin WebDAV standard de Nextcloud pour les fichiers d'un utilisateur
  return `${URL_BASE}/remote.php/dav/files/${encodeURIComponent(USER)}`;
}

let folderChecked = false;
async function ensureFolder() {
  if (folderChecked) return;
  // MKCOL est idempotent côté usage : 405 = déjà existant, on ignore.
  try {
    const res = await fetch(`${davBase()}/${encodeURIComponent(FOLDER)}`, {
      method: "MKCOL",
      headers: { Authorization: authHeader() },
    });
    // 201 créé, 405 existe déjà — les deux sont OK
    if (res.status !== 201 && res.status !== 405) {
      throw new Error(`MKCOL ${res.status}`);
    }
    folderChecked = true;
  } catch (e) {
    throw new Error("Nextcloud injoignable: " + e.message);
  }
}

/**
 * Dépose une photo sur Nextcloud.
 * @param {string} name  nom de fichier (ex: 172...-ab12.jpg)
 * @param {Buffer} buffer  contenu binaire
 * @param {string} mime  type MIME
 * @returns {Promise<string>}  chemin distant relatif (FOLDER/name)
 */
export async function uploadPhoto(name, buffer, mime) {
  await ensureFolder();
  const remotePath = `${FOLDER}/${name}`;
  const res = await fetch(`${davBase()}/${encodeURIComponent(FOLDER)}/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": mime || "application/octet-stream" },
    body: buffer,
  });
  if (res.status !== 201 && res.status !== 204) {
    throw new Error(`Envoi Nextcloud échoué (${res.status})`);
  }
  return remotePath;
}

/**
 * Récupère une photo depuis Nextcloud.
 * @param {string} remotePath  chemin retourné par uploadPhoto (FOLDER/name)
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
export async function downloadPhoto(remotePath) {
  const res = await fetch(`${davBase()}/${remotePath.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Lecture Nextcloud échouée (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get("content-type") || "image/jpeg";
  return { buffer, mime };
}
