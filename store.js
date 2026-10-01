// Persistence + migration. The file on disk may be any older format (or damaged); load() always
// returns a valid current-format db, so nothing ever has to be deleted by hand.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { SCHEMA_VERSION, overridesFrom, effectiveProfile } from "./defaults.js";
import { cleanText, idFor, parseStatusUrl, classify } from "./importer.js";

const dir = () => process.env.DATA_DIR || "data";
const file = () => `${dir()}/db.json`;
export const notes = []; // things that happened at startup (migration, corruption), shown in Diagnostics
const note = (m) => { notes.push(`${new Date().toISOString()} ${m}`); console.warn(`[reply-radar] ${m}`); };

const fresh = () => ({ v: SCHEMA_VERSION, settings: {}, posts: [], lastImport: null });
const STATUSES = new Set(["new", "done", "skipped", "filtered"]);
const RANK = { done: 3, skipped: 2, new: 1, filtered: 0 };

/** Bring any older/odd db shape up to the current one. Pure: never throws on bad input. */
export function migrate(raw) {
  const db = fresh();
  if (!raw || typeof raw !== "object") return db;

  // v1 stored the whole merged profile (including defaults) under `profile`; keep only real user choices.
  db.settings = overridesFrom(raw.settings ?? raw.profile);
  db.lastImport = raw.lastImport && typeof raw.lastImport === "object" ? raw.lastImport : null;

  const profile = effectiveProfile(db.settings);
  const list = Array.isArray(raw.posts) ? raw.posts : Array.isArray(raw.replies) ? raw.replies : [];
  const byId = new Map();
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const text = cleanText(o.text);
    if (!text) continue;
    const st = parseStatusUrl(o.url);
    const author = String(o.author || st?.handle || "unknown").replace(/^@/, "").replace(/^RR:?\w*$/i, "unknown");
    const tweetId = String(o.tweetId || st?.id || "").match(/^\d{5,25}$/)?.[0];
    const id = idFor({ author, tweetId, text });
    let status = o.status === "replied" ? "done" : STATUSES.has(o.status) ? o.status : "new";
    const drafts = (Array.isArray(o.drafts) ? o.drafts : []).map((d) => String(d).trim()).filter(Boolean).slice(0, 4);
    const kind = o.kind === "reply" ? "reply" : "post";
    const c = classify({ author, tweetId, text }, profile, kind);
    if (status === "new" && !c.eligible) status = "filtered";
    const rec = {
      id, tweetId, author, name: String(o.name || ""), text, kind, score: c.score, status,
      filterReason: status === "filtered" ? c.reason || "low relevance" : undefined,
      drafts, gen: drafts.length ? { state: "ok", attempts: 1 } : { state: status === "new" ? "pending" : "none", attempts: 0 },
      addedAt: o.addedAt || new Date().toISOString(), openedAt: o.openedAt || undefined,
    };
    const prev = byId.get(id);
    // On duplicates keep whichever record progressed furthest (done > skipped > new).
    if (!prev || RANK[rec.status] > RANK[prev.status]) byId.set(id, rec);
  }
  db.posts = [...byId.values()];
  return db;
}

export function load() {
  if (!existsSync(file())) return fresh();
  let raw;
  try { raw = JSON.parse(readFileSync(file(), "utf8")); }
  catch (e) {
    const bak = `${dir()}/db.corrupt-${Date.now()}.json`;
    try { renameSync(file(), bak); } catch { /* ignore */ }
    note(`db.json was unreadable (${e.message}). Moved to ${bak} and started fresh.`);
    return fresh();
  }
  if (raw?.v === SCHEMA_VERSION && Array.isArray(raw.posts)) {
    if (!raw.settings || typeof raw.settings !== "object") raw.settings = {};
    return raw;
  }
  const db = migrate(raw);
  note(`Migrated db.json to format v${SCHEMA_VERSION} (${db.posts.length} posts kept).`);
  save(db);
  return db;
}

export function save(db) {
  db.v = SCHEMA_VERSION;
  if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
  writeFileSync(`${file()}.tmp`, JSON.stringify(db, null, 2));
  renameSync(`${file()}.tmp`, file());
}

/** Load, mutate, save. Everything that changes data goes through here. */
export function update(fn) {
  const db = load();
  const out = fn(db);
  save(db);
  return out;
}
