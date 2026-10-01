import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { load, update, notes } from "./store.js";
import { effectiveProfile, overridesFrom, DEFAULT_PROFILE, SCHEMA_VERSION, MY_HANDLE, MOODS, PROMOS } from "./defaults.js";
import { parseClipboard, importPosts, postUrl } from "./importer.js";
import { kick, recover, retry, generationStats } from "./generator.js";
import * as llm from "./llm.js";

const startedAt = new Date().toISOString();
const pub = (name) => new URL(`./public/${name}`, import.meta.url);
const STATUSES = ["new", "done", "skipped"];

async function assets() {
  const [html, js] = await Promise.all([readFile(pub("index.html"), "utf8"), readFile(pub("extract.js"), "utf8")]);
  const version = createHash("sha1").update(html).update(js).digest("hex").slice(0, 10);
  return { html: html.replaceAll("{{V}}", version), js, version };
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 3e6) throw Object.assign(new Error("payload too large"), { code: 413 });
  }
  try { return JSON.parse(raw || "{}"); }
  catch { throw Object.assign(new Error("invalid JSON"), { code: 400 }); }
}

const view = (p) => ({ ...p, url: postUrl(p) });

function state(version) {
  const db = load();
  const posts = db.posts.map(view).sort((a, b) => b.score - a.score || (a.addedAt < b.addedAt ? 1 : -1));
  const count = (s) => db.posts.filter((p) => p.status === s).length;
  const gen = { pending: 0, working: 0, ok: 0, error: 0 };
  for (const p of db.posts) if (p.status === "new" && gen[p.gen?.state] !== undefined) gen[p.gen.state]++;
  return {
    assetVersion: version, posts,
    counts: { queue: count("new"), done: count("done"), skipped: count("skipped"), filtered: count("filtered") },
    lastImport: db.lastImport,
    profile: effectiveProfile(db.settings), defaults: DEFAULT_PROFILE, overrides: db.settings,
    moods: Object.entries(MOODS).map(([key, v]) => ({ key, label: v.label })),
    promos: Object.entries(PROMOS).map(([key, label]) => ({ key, label })),
    diagnostics: {
      startedAt, schema: SCHEMA_VERSION, model: llm.model(), hasKey: llm.enabled(), myHandle: MY_HANDLE(),
      generation: { queue: gen, session: generationStats() }, notes,
      dataDir: process.env.DATA_DIR || "data",
    },
  };
}

async function route(req, res, url) {
  const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const m = req.method, p = url.pathname;

  // Only this machine's own page may call the API (blocks other websites from poking localhost).
  const origin = req.headers.origin;
  if (origin && m !== "GET" && new URL(origin).host !== req.headers.host) return send(403, { error: "forbidden origin" });

  if (m === "GET" && (p === "/" || p === "/extract.js")) {
    const a = await assets();
    res.writeHead(200, { "Content-Type": p === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(p === "/" ? a.html : a.js);
  }
  if (m === "GET" && p === "/api/state") return send(200, state((await assets()).version));

  if (m === "POST" && p === "/api/import") {
    const { text } = await readBody(req);
    const parsed = parseClipboard(text);
    if (parsed.error) {
      update((db) => { db.lastImport = { at: new Date().toISOString(), error: parsed.error, found: 0, added: 0, duplicates: 0, ownSkipped: 0, invalid: 0, filtered: {} }; });
      return send(422, { error: parsed.error });
    }
    const report = update((db) => (db.lastImport = importPosts(db, parsed, effectiveProfile(db.settings))));
    kick();
    return send(200, { report });
  }

  let mm;
  if (m === "POST" && (mm = p.match(/^\/api\/posts\/([\w]+)\/(status|opened|retry|restore)$/))) {
    const [, id, action] = mm;
    if (!load().posts.some((x) => x.id === id)) return send(404, { error: "post not found" });
    if (action === "retry") { retry(id); return send(200, { ok: true }); }
    const body = await readBody(req);
    if (action === "status" && !STATUSES.includes(body.status)) return send(400, { error: "bad status" });
    update((db) => {
      const post = db.posts.find((x) => x.id === id);
      if (action === "status") post.status = body.status;
      if (action === "opened") post.openedAt = new Date().toISOString();
      if (action === "restore") { post.status = "new"; post.gen = post.drafts?.length ? { state: "ok" } : { state: "pending", attempts: 0 }; }
    });
    kick();
    return send(200, { ok: true });
  }
  if (m === "PUT" && p === "/api/settings") {
    const body = await readBody(req);
    update((db) => { db.settings = overridesFrom(body); });
    return send(200, { ok: true });
  }
  if (m === "POST" && p === "/api/history/reset") {
    update((db) => { db.posts = db.posts.filter((x) => x.status === "new"); });
    return send(200, { ok: true });
  }
  send(404, { error: "not found" });
}

export function createApp() {
  load();      // runs migration/repair once at startup
  recover();   // resume generation that a crash interrupted
  const server = createServer((req, res) =>
    route(req, res, new URL(req.url, "http://x")).catch((e) => {
      if (!e.code) console.error(e);
      res.writeHead(e.code || 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.code ? e.message : "internal error, see the terminal" }));
    }));
  server.on("listening", kick);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 3000;
  const server = createApp();
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use. Is Reply Radar already running? Close that terminal or set PORT in .env.` : e);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`Reply Radar -> http://localhost:${port}   model: ${llm.model()}   AI key: ${llm.enabled() ? "yes" : "MISSING"}`));
}
