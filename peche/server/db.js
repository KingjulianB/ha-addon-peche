import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Le fichier de base de données. Modifiable via la variable d'environnement DB_PATH.
// Par défaut : ./data/peche.db (pensez à sauvegarder ce fichier régulièrement).
const DB_PATH = process.env.DB_PATH || "./data/peche.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // meilleures performances et robustesse

// --- Schéma ---
db.exec(`
CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,          -- AAAA-MM-JJ
  depart     TEXT,                   -- HH:MM
  retour     TEXT,
  zone       TEXT,
  crew       TEXT,                   -- JSON: ["Ndong", ...]
  prises     TEXT,                   -- JSON: [{esp, kg, prix}, ...]
  par        TEXT,                   -- qui a pesé / saisi
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  depart     TEXT,
  retour     TEXT,
  points     TEXT NOT NULL,          -- JSON: [{lat, lon, t}, ...]
  dist_km    REAL,
  duree_h    REAL,
  source     TEXT DEFAULT 'manuel',  -- 'manuel' | 'nemo'
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_trips_date  ON trips(date);
CREATE INDEX IF NOT EXISTS idx_tracks_date ON tracks(date);
`);

// Réglages par défaut (au premier lancement)
const seedSettings = db.prepare(
  "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)"
);
const DEFAULTS = {
  fuel_mode: "hour",          // 'hour' (L/h) ou 'dist' (L/100km)
  fuel_conso: "7",            // conso hors-bord typique
  fuel_prix: "700",           // FCFA / litre
  zone_lat: "-0.72",
  zone_lon: "8.78",
  zone_radius: "15",          // km
  map_span: "60",             // km affichés
  crew: JSON.stringify(["Ndong", "Mavoungou", "Ekomi", "Boussougou"]),
  boat_id: "GA-PG-2214",
};
for (const [k, v] of Object.entries(DEFAULTS)) seedSettings.run(k, v);

// --- Helpers ---
export const Trips = {
  all: db.prepare("SELECT * FROM trips ORDER BY date DESC, depart DESC"),
  insert: db.prepare(`INSERT INTO trips (id,date,depart,retour,zone,crew,prises,par,note,created_at)
                      VALUES (@id,@date,@depart,@retour,@zone,@crew,@prises,@par,@note,@created_at)`),
  del: db.prepare("DELETE FROM trips WHERE id = ?"),
};

export const Tracks = {
  all: db.prepare("SELECT id,date,depart,retour,dist_km,duree_h,source,created_at FROM tracks ORDER BY date DESC"),
  one: db.prepare("SELECT * FROM tracks WHERE id = ?"),
  insert: db.prepare(`INSERT INTO tracks (id,date,depart,retour,points,dist_km,duree_h,source,created_at)
                      VALUES (@id,@date,@depart,@retour,@points,@dist_km,@duree_h,@source,@created_at)`),
  del: db.prepare("DELETE FROM tracks WHERE id = ?"),
};

export const Settings = {
  all: db.prepare("SELECT key, value FROM settings"),
  set: db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
};

export function getSettings() {
  const rows = Settings.all.all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export default db;
