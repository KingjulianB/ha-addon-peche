// ============================================================
//  POINT DE BRANCHEMENT IDENTIFICATION AUTOMATIQUE (espèce + poids)
// ============================================================
// Reconnaissance d'espèce (et estimation de poids) à partir d'une photo,
// via un modèle de réseau de neurones entraîné séparément puis exporté
// au format ONNX — voir ml/README.md pour l'entraînement.
//
// Fonctionnalité OPTIONNELLE, désactivée proprement tant qu'aucun
// modèle n'est présent : la saisie manuelle des captures continue de
// fonctionner normalement (identifyPhoto() refuse alors explicitement,
// même logique que nemo.js pour la balise VMS).
//
// Pour l'activer : voir ml/README.md, puis déposez model.onnx et
// labels.json dans ml/ (ou pointez FISHID_MODEL_PATH / FISHID_LABELS_PATH
// ailleurs). Aucun redémarrage de code n'est nécessaire, juste un
// redémarrage du serveur pour recharger le modèle.
// ============================================================

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ML_DIR = join(__dirname, "..", "ml");

const MODEL_PATH = process.env.FISHID_MODEL_PATH || join(ML_DIR, "model.onnx");
const LABELS_PATH = process.env.FISHID_LABELS_PATH || join(ML_DIR, "labels.json");
const WEIGHTS_PATH = process.env.FISHID_WEIGHTS_PATH || join(ML_DIR, "species_weights.json");

// Doit correspondre à INPUT_SIZE dans ml/train.py
const INPUT_SIZE = 224;

let session = null;  // session ONNX Runtime, chargée une seule fois à la demande
let labels = null;   // espèces, dans l'ordre des classes du modèle
let weights = {};    // poids moyen (kg) par espèce, pour l'estimation

export function fishIdConfigured() {
  return existsSync(MODEL_PATH) && existsSync(LABELS_PATH);
}

let weightsLoaded = false;
// Chargé indépendamment du modèle ONNX : utilisé aussi par
// estimateWeightFromLength(), qui n'a pas besoin d'identifier l'espèce
// depuis une photo (ex: appelée depuis l'appli mobile compagnon avec une
// espèce déjà connue).
function loadWeights() {
  if (weightsLoaded) return;
  weightsLoaded = true;
  if (existsSync(WEIGHTS_PATH)) {
    const raw = JSON.parse(readFileSync(WEIGHTS_PATH, "utf8"));
    delete raw._readme;
    weights = raw;
  }
}

async function loadModel() {
  if (session) return session;
  // Backend WASM (pas de binding natif) : évite le souci de compatibilité
  // glibc/musl d'onnxruntime-node sur l'image Docker Alpine de l'add-on —
  // voir planning/discrepancies.md § ML runtime vs. Alpine Docker base image.
  const ort = await import("onnxruntime-web");
  session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ["wasm"] });
  labels = JSON.parse(readFileSync(LABELS_PATH, "utf8"));
  loadWeights();
  return session;
}

// Convertit une photo (data URL) en tenseur CHW/RGB normalisé [0,1],
// même prétraitement que ml/train.py (Resize + ToTensor, sans normalisation
// par moyenne/écart-type — à garder synchronisé si train.py change).
async function preprocess(dataUrl) {
  const { Jimp } = await import("jimp");
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  const buf = Buffer.from(base64, "base64");
  const img = await Jimp.read(buf);
  img.resize({ w: INPUT_SIZE, h: INPUT_SIZE });

  const data = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const plane = INPUT_SIZE * INPUT_SIZE;
  img.scan(0, 0, INPUT_SIZE, INPUT_SIZE, (x, y, idx) => {
    const p = y * INPUT_SIZE + x;
    data[p] = img.bitmap.data[idx] / 255;
    data[plane + p] = img.bitmap.data[idx + 1] / 255;
    data[2 * plane + p] = img.bitmap.data[idx + 2] / 255;
  });
  return data;
}

function softmaxConfidence(logits, bestIdx) {
  const max = Math.max(...logits);
  const exps = Array.from(logits, (v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps[bestIdx] / sum;
}

/**
 * Identifie l'espèce et estime le poids à partir d'une photo (data URL).
 * L'estimation de poids n'est PAS une mesure : sans repère d'échelle
 * dans la photo, c'est un poids typique par espèce (species_weights.json)
 * — à toujours présenter au pêcheur comme une estimation à confirmer,
 * jamais comme une valeur mesurée (voir planning/agreed-workflow.md).
 *
 * @param {string} dataUrl
 * @returns {Promise<{espece:string, especeFr:string, confiance:number, poidsEstimeKg:number|null}>}
 */
export async function identifyPhoto(dataUrl) {
  if (!fishIdConfigured()) {
    throw new Error(
      "Identification automatique non configurée : aucun modèle entraîné trouvé " +
      "(ml/model.onnx). Voir ml/README.md pour l'entraîner. La saisie manuelle reste disponible."
    );
  }
  const s = await loadModel();
  const input = await preprocess(dataUrl);

  const ort = await import("onnxruntime-web");
  const tensor = new ort.Tensor("float32", input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const inputName = s.inputNames[0];
  const outputs = await s.run({ [inputName]: tensor });
  const logits = outputs[s.outputNames[0]].data;

  let best = 0;
  for (let k = 1; k < logits.length; k++) if (logits[k] > logits[best]) best = k;

  const espece = labels[best] || "inconnue";
  const info = weights[espece];
  return {
    espece,
    especeFr: info?.nom_fr || espece,
    confiance: softmaxConfidence(logits, best),
    poidsEstimeKg: info?.poids_kg ?? null,
  };
}

/**
 * Estime le poids à partir de l'espèce ET d'une longueur mesurée (cm),
 * via la relation taille-poids allométrique W = a × L^b (a, b par
 * espèce dans species_weights.json). Bien plus précis qu'un poids
 * moyen par espèce (identifyPhoto()) SI la longueur est mesurée
 * correctement (ex: app compagnon avec LiDAR/profondeur) et si les
 * coefficients a/b sont fiables pour l'espèce — voir l'avertissement
 * dans species_weights.json : les valeurs actuelles sont des valeurs
 * de départ non vérifiées auprès de FishBase espèce par espèce, pas
 * une donnée scientifique validée.
 *
 * @param {string} espece - doit correspondre exactement à une clé de species_weights.json
 * @param {number} longueurCm
 * @returns {{poidsKg:number, methode:"allometrie"|"moyenne_espece", fiable:boolean}}
 */
export function estimateWeightFromLength(espece, longueurCm) {
  loadWeights();
  const info = weights[espece];
  if (!info) {
    throw new Error(`Espèce inconnue : "${espece}".`);
  }
  if (!(longueurCm > 0)) {
    throw new Error("Longueur invalide.");
  }
  if (info.a != null && info.b != null) {
    const poidsKg = (info.a * Math.pow(longueurCm, info.b)) / 1000; // a,b calibrés en grammes/cm (convention FishBase)
    return { poidsKg, methode: "allometrie", fiable: false };
  }
  // Pas de coefficients a/b pour cette espèce (ex: crevette, pas un poisson) : repli sur le poids moyen.
  if (info.poids_kg != null) {
    return { poidsKg: info.poids_kg, methode: "moyenne_espece", fiable: false };
  }
  throw new Error(`Aucune donnée de poids pour "${espece}".`);
}
