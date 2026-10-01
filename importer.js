// Turns clipboard text into clean posts, decides which are worth showing, and merges them into the db.
import { createHash } from "node:crypto";
import { MY_HANDLE } from "./defaults.js";

const STATUS_RE = /(?:^|\/\/|\.)(?:x|twitter)\.com\/(\w{1,15})\/status\/(\d+)/i;

export const parseStatusUrl = (url) => {
  const m = String(url || "").match(STATUS_RE);
  return m ? { handle: m[1], id: m[2] } : null;
};
export const postUrl = (p) => (p.tweetId && p.author && p.author !== "unknown" ? `https://x.com/${p.author}/status/${p.tweetId}` : null);

const UI_LINE = /^(reply|repost|reposts|like|likes|share|bookmark|bookmarks|views?|show more|show this thread|quote|promoted|ad|follow|subscribe|translate post)$/i;
const COUNT_LINE = /^[\d.,]+\s?[kKmM]?$|^[\d.,]+\s?[kKmM]?\s+(replies|reply|reposts?|likes?|views?|bookmarks?)$/i;

/** Strip UI noise and old import markers that must never end up in a post. */
export function cleanText(raw) {
  let t = String(raw ?? "").replace(/\r/g, "").replace(/^\s*RR1?:?(post|reply)?\s*(?:@\w{1,15}:\s*)?/i, "");
  const lines = t.split("\n").map((l) => l.trim()).filter((l) => !UI_LINE.test(l) && !COUNT_LINE.test(l));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const idFor = (p) =>
  p.tweetId ? `t${p.tweetId}` : "h" + createHash("sha1").update(`${p.author}|${p.text}`.toLowerCase()).digest("hex").slice(0, 12);

/** Parse whatever is on the clipboard. Returns { posts, invalid, meta } or { error }. */
export function parseClipboard(input) {
  const t = String(input ?? "").replace(/^﻿/, "").trim();
  if (!t) return { error: "The clipboard is empty. Click the bookmark on X first." };

  if (t.startsWith("RR1")) {
    let payload;
    try { payload = JSON.parse(t.slice(3).trim()); }
    catch { return { error: "The copied data is damaged. Click the bookmark on X again." }; }
    const raw = Array.isArray(payload?.posts) ? payload.posts : null;
    if (!raw) return { error: "The copied data has no posts in it. Click the bookmark on X again." };
    if (!raw.length) {
      const a = payload.stats?.articles || 0;
      return { error: a
        ? `The bookmark saw ${a} tweets but could not read any of them. X may have changed its layout.`
        : "No posts were visible on that page. Scroll down so posts load, then click the bookmark again." };
    }
    let invalid = 0;
    const posts = [];
    for (const p of raw) {
      const id = String(p?.id ?? "");
      const handle = String(p?.handle ?? "").replace(/^@/, "");
      const text = cleanText(p?.text);
      if (!/^\d{5,25}$/.test(id) || !/^\w{1,15}$/.test(handle) || !text) { invalid++; continue; }
      posts.push({ tweetId: id, author: handle, name: String(p.name || "").slice(0, 60), text: text.slice(0, 1000) });
    }
    return { posts, invalid, meta: { page: payload.page, pageAuthor: payload.pageAuthor || null, source: "bookmark" } };
  }

  // Fallback: plain "@handle: text" blocks, optionally followed by a status URL.
  if (!/@\w{1,15}\s*[:\-]/.test(t) && !STATUS_RE.test(t))
    return { error: "That doesn't look like posts copied from X. Click the bookmark on x.com, then import." };
  const posts = [];
  for (const block of t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const url = block.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/\d+\S*/i)?.[0];
    const st = parseStatusUrl(url);
    const body = block.replace(url || "", "").trim();
    const m = body.match(/^@(\w{1,15})[:\s-]+([\s\S]+)$/);
    const text = cleanText(m ? m[2] : body);
    if (!text) continue;
    posts.push({ tweetId: st?.id, author: m ? m[1] : st?.handle || "unknown", name: "", text: text.slice(0, 1000) });
  }
  return posts.length ? { posts, invalid: 0, meta: { page: "search", source: "text" } } : { error: "Could not find any posts in that text." };
}

// ---- relevance -------------------------------------------------------------------------
const SPAM = [
  /\bdrop (your )?(sol(ana)?|wallet|address)/i, /\bgiveaway\b/i, /\b(claim|free) (airdrop|tokens?|sol)\b/i,
  /\bdm (me )?(to )?(claim|for)\b/i, /\bfollow\s*(\+|&|and)\s*(rt|retweet|repost)/i, /\b(rt|retweet|repost)\s*(\+|&|and)\s*follow/i,
  /\bcheck (my )?(bio|profile)\b/i, /\bclick (the )?link\b/i, /\bfirst \d+ (only|people|wallets)\b/i, /\bwallet address\b/i,
];
const BASE_KEYWORDS = new Set((
  "solana sol web3 crypto defi onchain on-chain dex memecoin memecoins nft token tokens trading trader traders trade perp perps hackathon " +
  "superteam anchor rust validator jupiter jup phantom helius pump ai agent agents llm gpt claude build building builder builders shipping dev devs " +
  "founder startup protocol wallet bull bear market alpha degen mev rpc sdk api ship launch bonk raydium drift kamino marginfi").split(" "));
const STOP = new Set(["the", "and", "for", "with", "tips", "tip"]);

const tokens = (s) => s.toLowerCase().match(/[a-z0-9$#_]+/g) || [];
const topicWords = (topics) => [...new Set(topics.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2 && !STOP.has(w)))];

/** Decide whether a post is worth a card. Deliberately permissive: only obvious spam and junk are filtered. */
export function classify(post, profile, kind = "post") {
  const text = post.text;
  if (SPAM.some((re) => re.test(text))) return { eligible: false, reason: "spam", score: 0 };
  if (text.replace(/https?:\S+/g, "").trim().length < 12) return { eligible: false, reason: "too short", score: 0 };

  const tk = new Set(tokens(text));
  const lower = text.toLowerCase();
  const tw = topicWords(profile.topics);
  const topicHits = tw.filter((w) => tk.has(w) || (w.length >= 5 && lower.includes(w))).length;
  const baseHit = [...tk].some((w) => BASE_KEYWORDS.has(w.replace(/^[$#]/, "")));
  if (kind === "post" && !topicHits && !baseHit) return { eligible: false, reason: "low relevance", score: 0 };

  let score = kind === "reply" ? 40 : 30;
  score += Math.min(36, topicHits * 12) + (baseHit ? 5 : 0);
  if (/\?/.test(text)) score += 15;
  if (/\b(anyone|thoughts|recommend|advice|struggling|stuck|looking for|how do|what do you)\b/i.test(text)) score += 10;
  if (kind === "reply" && /\b(hire|collab|partner|sponsor|invest|dm me|reach out)\b/i.test(text)) score += 20;
  if (text.length < 40) score -= 10;
  return { eligible: true, score: Math.max(1, Math.min(100, score)) };
}

/** Merge parsed posts into db.posts and return a report of exactly what happened to each. */
export function importPosts(db, parsed, profile, now = new Date().toISOString()) {
  const me = MY_HANDLE();
  const byId = new Map(db.posts.map((p) => [p.id, p]));
  const kind = parsed.meta?.page === "status" && parsed.meta.pageAuthor?.toLowerCase() === me ? "reply" : "post";
  const report = {
    at: now, source: parsed.meta?.source, kind,
    found: parsed.posts.length + (parsed.invalid || 0),
    invalid: parsed.invalid || 0, added: 0, duplicates: 0, ownSkipped: 0,
    filtered: { spam: 0, "too short": 0, "low relevance": 0 }, error: null,
  };
  for (const raw of parsed.posts) {
    if (raw.author.toLowerCase() === me) { report.ownSkipped++; continue; }
    const id = idFor(raw);
    if (byId.has(id)) { report.duplicates++; continue; }
    const c = classify(raw, profile, kind);
    const rec = {
      id, tweetId: raw.tweetId, author: raw.author, name: raw.name, text: raw.text, kind,
      score: c.score, status: c.eligible ? "new" : "filtered", filterReason: c.reason,
      drafts: [], gen: { state: c.eligible ? "pending" : "none", attempts: 0 }, addedAt: now,
    };
    db.posts.push(rec);
    byId.set(id, rec);
    if (c.eligible) report.added++; else report.filtered[c.reason]++;
  }
  return report;
}
