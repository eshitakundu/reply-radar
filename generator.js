// Background reply generation. Each post is its own job: one failure never blocks the others.
import { load, save } from "./store.js";
import { effectiveProfile } from "./defaults.js";
import * as llm from "./llm.js";

const CONCURRENCY = 2;
const inflight = new Set();
const stats = { ok: 0, failed: 0 };
export const generationStats = () => ({ ...stats, running: inflight.size });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function patch(id, fn) {
  const db = load();
  const p = db.posts.find((x) => x.id === id);
  if (p) { fn(p); save(db); }
}

async function run(post, profile) {
  const retryDelay = Number(process.env.LLM_RETRY_DELAY_MS ?? 6000);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { drafts, usedModel } = await llm.draftReplies(post, profile);
      patch(post.id, (p) => { p.drafts = drafts; p.gen = { state: "ok", attempts: attempt, model: usedModel }; });
      stats.ok++;
      return;
    } catch (e) {
      lastErr = e;
      if (!e.transient || attempt === 2) break;
      await sleep(retryDelay);
    }
  }
  stats.failed++;
  patch(post.id, (p) => { p.gen = { state: "error", attempts: 2, error: lastErr.message }; });
}

/** Start jobs for any pending posts (up to the concurrency limit). Safe to call any time. */
export function kick() {
  while (inflight.size < CONCURRENCY) {
    const db = load();
    const next = db.posts
      .filter((p) => p.status === "new" && p.gen?.state === "pending" && !inflight.has(p.id))
      .sort((a, b) => b.score - a.score)[0];
    if (!next) return;
    next.gen = { ...next.gen, state: "working", startedAt: new Date().toISOString() };
    save(db);
    inflight.add(next.id);
    const profile = effectiveProfile(db.settings);
    run(next, profile).catch((e) => patch(next.id, (p) => { p.gen = { state: "error", error: e.message }; }))
      .finally(() => { inflight.delete(next.id); kick(); });
  }
}

/** After a crash/restart, jobs stuck in "working" go back to pending. */
export function recover() {
  const db = load();
  let n = 0;
  for (const p of db.posts) if (p.gen?.state === "working" && !inflight.has(p.id)) { p.gen = { ...p.gen, state: "pending" }; n++; }
  if (n) save(db);
}

export function retry(id) {
  patch(id, (p) => { if (p.status === "new") p.gen = { state: "pending", attempts: 0 }; });
  kick();
}
