import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.DB_PATH || "./data/peche.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  depart     TEXT,
  retour     TEXT,
  zone       TEXT,
  crew       TEXT,
  prises     TEXT,
  par        TEXT,
  note       TEXT,
  owner      TEXT,
  locked     INTEGER DEFAULT 1,
  photo      TEXT,
  gps_lat    REAL,
  gps_lon    REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  depart     TEXT,
  retour     TEXT,
  points     TEXT NOT NULL,
  dist_km    REAL,
  duree_h    REAL,
  source     TEXT DEFAULT 'manuel',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,          -- carburant | paye | materiel | transport | licence | panne | autre
  label      TEXT,
  amount     REAL NOT NULL,          -- FCFA
  trip_id    TEXT,                   -- sortie liée (optionnel)
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pannes (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  titre       TEXT NOT NULL,         -- ex: "Moteur hors-bord"
  constat     TEXT,                  -- description du problème
  cout        REAL DEFAULT 0,        -- coût de réparation (FCFA)
  statut      TEXT DEFAULT 'ouverte',-- ouverte | reparee
  photos      TEXT,                  -- JSON: liste de références photo
  expense_id  TEXT,                  -- dépense créée automatiquement
  created_at  INTEGER NOT NULL
);
`);

function ensureColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
ensureColumn("trips", "owner", "TEXT");
ensureColumn("trips", "locked", "INTEGER DEFAULT 1");
ensureColumn("trips", "photo", "TEXT");
ensureColumn("trips", "gps_lat", "REAL");
ensureColumn("trips", "gps_lon", "REAL");
ensureColumn("trips", "depart_date", "TEXT");   // date de départ (marée pluri-jours)
ensureColumn("trips", "arrivee_date", "TEXT");  // date de débarquement = référence
ensureColumn("tracks", "validated", "INTEGER DEFAULT 0");

// Migration douce des anciennes sorties (une seule date) :
// l'ancienne "date" devient à la fois le départ et le débarquement.
db.prepare(`UPDATE trips SET depart_date = date WHERE depart_date IS NULL`).run();
db.prepare(`UPDATE trips SET arrivee_date = date WHERE arrivee_date IS NULL`).run();

// Les index sont créés APRÈS la migration des colonnes, car ils peuvent
// porter sur des colonnes ajoutées ci-dessus (ex. owner) qui n'existent pas
// encore sur une base créée par une version antérieure.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_trips_date  ON trips(date);
CREATE INDEX IF NOT EXISTS idx_trips_owner ON trips(owner);
CREATE INDEX IF NOT EXISTS idx_tracks_date ON tracks(date);
CREATE INDEX IF NOT EXISTS idx_exp_trip ON expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
`);

const seedSettings = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
const DEFAULTS = {
  fuel_mode: "hour", fuel_conso: "7", fuel_prix: "700",
  zone_lat: "-0.72", zone_lon: "8.78", zone_radius: "15", map_span: "60",
  crew: JSON.stringify(["Ndong", "Mavoungou", "Ekomi", "Boussougou"]),
  boat_id: "GA-PG-2214",
};
for (const [k, v] of Object.entries(DEFAULTS)) seedSettings.run(k, v);

export const Users = {
  byName: db.prepare("SELECT * FROM users WHERE username = ?"),
  all: db.prepare("SELECT id, username, role, created_at FROM users ORDER BY role, username"),
  insert: db.prepare("INSERT INTO users (id, username, password, role, created_at) VALUES (@id,@username,@password,@role,@created_at)"),
  updatePassword: db.prepare("UPDATE users SET password = ? WHERE username = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM users"),
};

export const Trips = {
  all: db.prepare("SELECT * FROM trips ORDER BY arrivee_date DESC, retour DESC"),
  byOwner: db.prepare("SELECT * FROM trips WHERE owner = ? ORDER BY arrivee_date DESC, retour DESC"),
  one: db.prepare("SELECT * FROM trips WHERE id = ?"),
  insert: db.prepare(`INSERT INTO trips (id,date,depart,retour,depart_date,arrivee_date,zone,crew,prises,par,note,owner,locked,photo,gps_lat,gps_lon,created_at)
                      VALUES (@id,@date,@depart,@retour,@depart_date,@arrivee_date,@zone,@crew,@prises,@par,@note,@owner,@locked,@photo,@gps_lat,@gps_lon,@created_at)`),
  update: db.prepare(`UPDATE trips SET date=@date,depart=@depart,retour=@retour,depart_date=@depart_date,arrivee_date=@arrivee_date,zone=@zone,crew=@crew,prises=@prises,par=@par,note=@note WHERE id=@id`),
  del: db.prepare("DELETE FROM trips WHERE id = ?"),
};

export const Tracks = {
  all: db.prepare("SELECT id,date,depart,retour,dist_km,duree_h,source,validated,created_at FROM tracks ORDER BY date DESC"),
  one: db.prepare("SELECT * FROM tracks WHERE id = ?"),
  insert: db.prepare(`INSERT INTO tracks (id,date,depart,retour,points,dist_km,duree_h,source,created_at)
                      VALUES (@id,@date,@depart,@retour,@points,@dist_km,@duree_h,@source,@created_at)`),
  validate: db.prepare("UPDATE tracks SET validated = 1 WHERE id = ?"),
  del: db.prepare("DELETE FROM tracks WHERE id = ?"),
};

export const Settings = {
  all: db.prepare("SELECT key, value FROM settings"),
  set: db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
};

export const Expenses = {
  all: db.prepare("SELECT * FROM expenses ORDER BY date DESC, created_at DESC"),
  byTrip: db.prepare("SELECT * FROM expenses WHERE trip_id = ?"),
  insert: db.prepare(`INSERT INTO expenses (id,date,type,label,amount,trip_id,created_at)
                      VALUES (@id,@date,@type,@label,@amount,@trip_id,@created_at)`),
  del: db.prepare("DELETE FROM expenses WHERE id = ?"),
};

export const Pannes = {
  all: db.prepare("SELECT * FROM pannes ORDER BY date DESC, created_at DESC"),
  one: db.prepare("SELECT * FROM pannes WHERE id = ?"),
  insert: db.prepare(`INSERT INTO pannes (id,date,titre,constat,cout,statut,photos,expense_id,created_at)
                      VALUES (@id,@date,@titre,@constat,@cout,@statut,@photos,@expense_id,@created_at)`),
  update: db.prepare(`UPDATE pannes SET titre=@titre,constat=@constat,cout=@cout,statut=@statut WHERE id=@id`),
  setExpense: db.prepare("UPDATE pannes SET expense_id=? WHERE id=?"),
  del: db.prepare("DELETE FROM pannes WHERE id = ?"),
};

export function getSettings() {
  const out = {};
  for (const r of Settings.all.all()) out[r.key] = r.value;
  return out;
}

export { db, randomUUID };
export default db;
