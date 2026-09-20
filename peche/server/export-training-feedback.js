// ============================================================
//  Export des photos de la boucle de correction (voir db.js §
//  training_feedback) vers ml/data/<espèce>/, prêtes pour un
//  réentraînement (voir ml/README.md).
//
//  Ne tourne PAS dans le serveur — script à lancer à la main, avec les
//  mêmes variables d'environnement que le serveur (DB_PATH, NEXTCLOUD_*) :
//
//      DB_PATH=./data/peche.db node server/export-training-feedback.js
//
//  Pour chaque ligne de training_feedback, l'espèce confirmée par le
//  pêcheur (texte libre) est comparée aux noms connus (nom_fr dans
//  ml/species_weights.json, ou clé brute de ml/labels.json) pour
//  déterminer le dossier data/<classe>/ cible. Ce qui ne correspond à
//  aucune espèce connue est listé à part pour relecture manuelle —
//  jamais importé au hasard.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TrainingFeedback } from "./db.js";
import { nextcloudConfigured, downloadPhoto } from "./nextcloud.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || "./data/peche.db";
const PHOTO_DIR = join(dirname(DB_PATH), "photos");
const ML_DATA_DIR = join(__dirname, "..", "ml", "data");
const WEIGHTS_PATH = join(__dirname, "..", "ml", "species_weights.json");
const LABELS_PATH = join(__dirname, "..", "ml", "labels.json");

function loadClassMap() {
  // norm(texte confirmé) -> classe exacte (nom du dossier data/<classe>/)
  const map = new Map();
  const norm = (s) => String(s || "").trim().toLowerCase();

  if (existsSync(LABELS_PATH)) {
    for (const cls of JSON.parse(readFileSync(LABELS_PATH, "utf8"))) {
      map.set(norm(cls), cls);
    }
  }
  if (existsSync(WEIGHTS_PATH)) {
    const weights = JSON.parse(readFileSync(WEIGHTS_PATH, "utf8"));
    for (const [cls, info] of Object.entries(weights)) {
      if (cls === "_readme") continue;
      if (info.nom_fr) map.set(norm(info.nom_fr), cls);
    }
  }
  return map;
}

const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function fetchPhoto(ref) {
  if (ref.startsWith("nc:")) {
    if (!nextcloudConfigured()) throw new Error("photo sur Nextcloud mais NEXTCLOUD_* non configuré ici");
    const { buffer, mime } = await downloadPhoto(ref.slice(3));
    return { buffer, ext: MIME_EXT[mime] || "jpg" };
  }
  const p = join(PHOTO_DIR, ref.replace(/[^a-zA-Z0-9._-]/g, ""));
  if (!existsSync(p)) throw new Error("fichier local introuvable : " + p);
  const ext = (ref.split(".").pop() || "jpg").toLowerCase();
  return { path: p, ext };
}

async function main() {
  const classMap = loadClassMap();
  const rows = TrainingFeedback.all.all();
  console.log(`${rows.length} entrée(s) dans training_feedback.`);

  let written = 0;
  const unmatched = [];
  const failed = [];

  for (const row of rows) {
    const cls = classMap.get(String(row.espece_confirmee || "").trim().toLowerCase());
    if (!cls) { unmatched.push(row); continue; }

    const destDir = join(ML_DATA_DIR, cls);
    mkdirSync(destDir, { recursive: true });

    try {
      const photo = await fetchPhoto(row.photo);
      const destFile = join(destDir, `feedback_${row.id}.${photo.ext}`);
      if (photo.path) copyFileSync(photo.path, destFile);
      else writeFileSync(destFile, photo.buffer);
      written++;
    } catch (e) {
      failed.push({ row, error: e.message });
    }
  }

  console.log(`${written} photo(s) exportée(s) vers ml/data/<espèce>/.`);
  if (unmatched.length) {
    console.log(`\n${unmatched.length} entrée(s) avec une espèce non reconnue (pas importées) :`);
    for (const r of unmatched) {
      console.log(`  - "${r.espece_confirmee}" (proposé: "${r.espece_predite}", ${r.corrige ? "corrigé" : "non corrigé"})`);
    }
    console.log("Si ce sont de vraies espèces, ajoutez-les à ml/species_weights.json (nom_fr) et relancez.");
  }
  if (failed.length) {
    console.log(`\n${failed.length} photo(s) inaccessible(s) :`);
    for (const f of failed) console.log(`  - ${f.row.id} : ${f.error}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
