// Canonical defaults. Stored settings only hold what the user deliberately changed;
// everything else is filled in from here on every read, so defaults can never go missing.
export const SCHEMA_VERSION = 2;
export const FIELDS = ["topics", "voice", "about", "site"];
export const MAX_LEN = { topics: 300, voice: 900, about: 500, site: 400 };

export const DEFAULT_PROFILE = Object.freeze({
  topics: "crypto trading, defi, web3 builders, ai agents, hackathon, building in public",
  voice:
    "casual builder crypto twitter. short, usually 1-2 sentences, conversational, lowercase is fine. " +
    "witty or a little shitposty when the post allows it. sounds like someone who actually trades and builds. " +
    "no corporate tone, no generic praise, no hype words, no emojis unless it really fits, no hashtags, no em dashes. " +
    "never just repeat the tweet. a question is fine sometimes, not every time.",
  about:
    "a builder posting about trading, web3 and AI agents, and building their own project.",
  site: "", // e.g. "Acme (acme.example): what it does in one line". Empty = nothing to promote.
});

/** Moods change the tone of newly written replies. "default" means just use the voice above. */
export const MOODS = Object.freeze({
  default: { label: "My normal voice", text: "" },
  chill: { label: "Chill and friendly", text: "relaxed, warm, low-key, supportive without being cheesy" },
  witty: { label: "Witty", text: "dry humor, clever one-liners, understated" },
  shitpost: { label: "Shitpost", text: "unhinged crypto twitter meme energy, absurd, self-aware, playful, but still coherent and on topic" },
  expert: { label: "Sharp and technical", text: "confident, specific, technical, brief, shows real hands-on knowledge" },
  excited: { label: "Excited", text: "genuinely enthusiastic and high energy, but not cringe or salesy" },
  spicy: { label: "Contrarian", text: "respectful but opinionated, offers a counter-take or pushes back on the consensus" },
});

/** How the user's own project may appear in replies. */
export const PROMOS = Object.freeze({
  off: "Don't mention my site",
  soft: "Mention my site only when it fits",
  link: "Mention it with the link when it fits",
});
export const DEFAULT_MODE = Object.freeze({ mood: "default", promo: "soft" });

// Values shipped as defaults in earlier versions. If a stored setting equals one of these
// the user never chose it, so migration drops it and the current default applies.
export const LEGACY_DEFAULTS = { topics: [], voice: ["casual, sharp, short sentences, opinionated but not arrogant, no hype words, no emojis"], about: [], site: [] };

export const MY_HANDLE = () => (process.env.MY_HANDLE || "").replace(/^@/, "").toLowerCase();

export const cleanField = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** Merge user overrides over defaults. Blank, missing or invalid values fall back to the default. */
export function effectiveProfile(settings) {
  const out = {};
  for (const f of FIELDS) out[f] = cleanField(settings?.[f]).slice(0, MAX_LEN[f]) || DEFAULT_PROFILE[f];
  out.mood = MOODS[settings?.mood] ? settings.mood : DEFAULT_MODE.mood;
  out.promo = PROMOS[settings?.promo] ? settings.promo : DEFAULT_MODE.promo;
  return out;
}

/** Normalise user-supplied settings into overrides only (drops blanks and values equal to a default). */
export function overridesFrom(input) {
  const out = {};
  for (const f of FIELDS) {
    const v = cleanField(input?.[f]).slice(0, MAX_LEN[f]);
    if (v && v !== DEFAULT_PROFILE[f] && !LEGACY_DEFAULTS[f].includes(v)) out[f] = v;
  }
  if (MOODS[input?.mood] && input.mood !== DEFAULT_MODE.mood) out.mood = input.mood;
  if (PROMOS[input?.promo] && input.promo !== DEFAULT_MODE.promo) out.promo = input.promo;
  return out;
}
