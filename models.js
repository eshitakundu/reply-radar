// Picks which OpenRouter model(s) to try. The free catalogue changes constantly and "openrouter/free"
// can route to non-chat models (e.g. safety classifiers), so we choose chat-capable free models ourselves.
const base = () => process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const NOT_CHAT = /safety|guard|moderat|embed|rerank|code|coder|omni|vision|-vl|image|audio|tts|whisper|reasoning|thinking|preview/i;
const FAMILY = /gemma|qwen|llama|mistral|nemotron-3-super|nemotron-3-ultra|deepseek|glm|kimi/i;
const FALLBACK = ["google/gemma-4-31b-it:free", "qwen/qwen3.8-27b:free", "nvidia/nemotron-3-super-120b-a12b:free"];

let cache = { at: 0, list: null };

/** User-chosen models (comma separated). "openrouter/free" and blank mean "choose for me". */
export function configured() {
  return (process.env.OPENROUTER_MODEL || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "openrouter/free" && s !== "auto");
}

async function discover() {
  if (cache.list && Date.now() - cache.at < 3_600_000) return cache.list;
  let list = FALLBACK;
  try {
    const res = await fetch(`${base()}/models`, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()).data || [];
    const free = data
      .filter((m) => m.id.endsWith(":free") && !NOT_CHAT.test(m.id) && (m.architecture?.output_modalities || ["text"]).join() === "text")
      .sort((a, b) => Number(FAMILY.test(b.id)) - Number(FAMILY.test(a.id)) || (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id);
    if (free.length) list = free;
  } catch { /* offline or blocked: use the static fallback */ }
  cache = { at: Date.now(), list };
  return list;
}

/** Ordered candidates to try: the user's choice first, then up to 3 discovered free chat models. */
export async function candidates() {
  const mine = configured();
  const auto = await discover();
  return [...new Set([...mine, ...auto])].slice(0, mine.length + 3);
}

export const describe = () => (configured().length ? configured().join(", ") + " (then auto)" : "auto (best free chat model)");
