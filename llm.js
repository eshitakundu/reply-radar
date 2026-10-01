// OpenRouter client + reply drafting. Every failure is turned into a readable Error with `.transient` set.
import { candidates, describe } from "./models.js";
import { MOODS } from "./defaults.js";

const base = () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
export const enabled = () => Boolean(process.env.OPENROUTER_API_KEY);
export const model = () => describe();
const timeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 30_000;

const fail = (message, transient, fatal = false) => Object.assign(new Error(message), { transient, fatal });

async function chat(modelId, messages) {
  if (!enabled()) throw fail("No OpenRouter key. Add OPENROUTER_API_KEY to .env and restart.", false, true);
  let res;
  try {
    res = await fetch(`${base()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Reply Radar" },
      body: JSON.stringify({ model: modelId, messages, temperature: 0.9, max_tokens: 1000, reasoning: { enabled: false } }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") throw fail(`Timed out after ${Math.round(timeoutMs() / 1000)}s waiting for ${modelId}.`, true);
    throw fail(`Network error talking to OpenRouter: ${e.cause?.code || e.message}`, true);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 160);
    if (res.status === 401 || res.status === 403) throw fail("OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY in .env.", false, true);
    if (res.status === 404 || res.status === 400) throw fail(`${modelId} is not available on OpenRouter right now (${res.status}). ${body}`, false);
    if (res.status === 402) throw fail(`${modelId} needs credits (402).`, false);
    if (res.status === 429) throw fail(`${modelId} is rate limited (429).`, true);
    throw fail(`OpenRouter error ${res.status}. ${body}`, res.status >= 500);
  }
  let data;
  try { data = await res.json(); } catch { throw fail("OpenRouter sent an unreadable response.", true); }
  const text = data.choices?.[0]?.message?.content;
  if (!text || !String(text).trim()) throw fail(`${data.model || modelId} returned an empty answer.`, true);
  return { text: String(text), usedModel: data.model || modelId };
}

const BANNED = /(great (insight|point|post|thread)|fascinating|this is (so )?(true|important)|couldn'?t agree more|spot on|well said|game.?changer|thanks for sharing|dive (in|into)|delve|as an ai)/i;
const LINK = /https?:\/\/\S+|\b[a-z0-9-]+\.(com|io|xyz|app|fi|gg|ai|so|dev|net|org|co|sh)\b/i;
const JUNK = /^(user|assistant|model|response|output)\b[^.!?]{0,20}:|^(safe|unsafe|ok|okay|sure|here (is|are))\b|^(first|second|reply|reply ?[12]|<.*>|\.\.\.)$|quip|agree.with.a.twist|concrete point|punchy reaction|real question\b|^(specific|punchy|quick|reaction|joke|question)\b.{0,30}[:\/]|\b(maybe (ask|mention)|you (could|should) (ask|mention)|the (original )?tweet)\b/i;

/** Clean one draft: no em dashes, no wrapping quotes, no hashtags, sane length. Returns "" if unusable. */
export function tidyDraft(s) {
  let t = String(s ?? "").trim()
    .replace(/\s*\((punchy|specific|joke|reaction|question|quip|angle|version)[^)]*\)\s*["']?$/i, "") // model labelling its own answer
    .replace(/\s*["”]\s*[-:]\s*[a-z ,]{3,40}$/i, "") // trailing '" - punchy, funny' label
    .replace(/^["'`“”]+|["'`“”]+$/g, "").trim();
  t = t.replace(/\s*[—–]\s*/g, ", ").replace(/\s+#\w+/g, "").replace(/\s{2,}/g, " ").trim();
  if (!t || t.length > 280 || BANNED.test(t)) return "";
  return t;
}

const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9']+/g) || []);
const similar = (a, b) => {
  const A = words(a), B = words(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, Math.min(A.size, B.size)) > 0.7;
};

/** Pull drafts out of a model answer. JSON first; a numbered/bulleted list only if it clearly is one. */
export function parseDrafts(text, avoid = [], { allowLinks = false } = {}) {
  let arr = null;
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      arr = Array.isArray(j) ? j : j.replies || j.drafts || null;
    } catch { /* fall through */ }
  }
  if (!Array.isArray(arr)) {
    const items = text.split("\n").map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/)?.[1]).filter(Boolean);
    arr = items.length >= 2 ? items : [];
  }
  const out = [];
  for (const d of arr) {
    const t = tidyDraft(typeof d === "string" ? d : d?.text);
    if (t.length >= 4 && /[a-z]/i.test(t) && !JUNK.test(t) && (allowLinks || !LINK.test(t)) && !avoid.some((x) => similar(x, t)) && !out.some((o) => similar(o, t))) out.push(t);
  }
  return out.slice(0, 2);
}

const RULES = `Hard rules:
- Write like a real person on crypto twitter. Casual, direct, lowercase is fine.
- 1-2 short sentences. Under 200 characters if you can.
- Never say things like "great insights", "fascinating", "this is so true", "well said", "thanks for sharing".
- No em dashes or en dashes. No hashtags. No emojis unless it truly fits. No hype words.
- Do not repeat or summarise the tweet. Add a take, a joke, a concrete detail or a real question.
- Not every reply should be a question. Never promote anything unless the promotion instructions below say you may.
- Match the energy: if the post is a joke or a meme, be funny back. If it is a real question, answer it briefly.`;

/** Try each candidate model in turn; a bad/busy/non-chat model just moves on to the next one. */
export async function draftReplies(post, profile) {
  const who = post.kind === "reply" ? "someone replying to the account owner's own post" : "a post by someone else";
  const mood = MOODS[profile.mood]?.text;
  const canPromo = Boolean(profile.site) && profile.promo !== "off";
  const extra = [
    mood ? `Mood for these replies: ${mood}.` : "",
    canPromo
      ? `The account owner is building this project: ${profile.site}\nReply 1 must NOT mention it. Reply 2 may mention it only if it is a natural fit for what this person is saying, as a casual first-person aside ("i've been building...", "we're working on..."), never a pitch, never "check out". If it is not a natural fit, reply 2 must not mention it either. ${profile.promo === "link" ? "When you do mention it, include its link." : "Never include a URL."}`
      : "",
  ].filter(Boolean).join("\n");
  const messages = [
    { role: "system", content:
      `You ghostwrite replies on X for the account owner. ${profile.about}\nTheir voice: ${profile.voice}\n\n${RULES}\n\n` +
      (extra ? `${extra}\n\n` : "") +
      `Write exactly 2 replies to the tweet. They must take different angles: one is a punchy reaction or joke, the other adds a specific point or asks a real question.\n\n` +
      `Example (different topic, do not reuse):\ntweet: "just spent 6 hours debugging a missing semicolon"\n` +
      `{"replies":["the semicolon was in the room the whole time","which language, so i know how much to pity you"]}\n\n` +
      `Now answer with ONLY a JSON object like the example, containing your 2 real replies to the tweet below.` },
    { role: "user", content: `This is ${who}, by @${post.author}:\n"""\n${post.text}\n"""` },
  ];
  // Weak free models sometimes echo the instructions back as if they were the reply; reject those.
  const echoes = messages[0].content.split(/\n|(?<=[.!?])\s+/).map((l) => l.replace(/^[-\s]+/, "").trim()).filter((l) => l.length > 12);
  const tried = [];
  for (const modelId of await candidates()) {
    try {
      const { text, usedModel } = await chat(modelId, messages);
      const drafts = parseDrafts(text, echoes, { allowLinks: canPromo && profile.promo === "link" });
      if (drafts.length) return { drafts, usedModel };
      tried.push(`${usedModel}: no usable reply`);
    } catch (e) {
      if (e.fatal) throw e;
      tried.push(e.message.includes(modelId) ? e.message : `${modelId}: ${e.message}`);
    }
  }
  throw fail(`Every model failed. ${tried.join(" | ")}`.slice(0, 500), true);
}
