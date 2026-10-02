import { test } from "node:test";
process.env.MY_HANDLE = "myhandle";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-openrouter.js";

const tmp = () => (process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rr-")));
const rr1 = (posts, extra = {}) => "RR1\n" + JSON.stringify({ rr: 1, page: "search", stats: { articles: posts.length }, posts, ...extra });
const P = (id, handle, text) => ({ id: String(id), handle, name: handle, text });

const { effectiveProfile, overridesFrom, DEFAULT_PROFILE } = await import("../defaults.js");
const { parseClipboard, cleanText, classify, importPosts } = await import("../importer.js");
const { migrate, load, save } = await import("../store.js");
const llm = await import("../llm.js");

test("defaults fill blank, missing and non-string settings", () => {
  for (const bad of [undefined, null, {}, { topics: "", voice: "   ", about: 5 }, "junk"])
    assert.deepEqual(effectiveProfile(bad), { ...DEFAULT_PROFILE, mood: "default", promo: "soft" });
});

test("intentional edits win over defaults and survive", () => {
  const o = overridesFrom({ voice: "  pure shitpost  ", topics: "", about: DEFAULT_PROFILE.about });
  assert.deepEqual(o, { voice: "pure shitpost" });
  assert.equal(effectiveProfile(o).voice, "pure shitpost");
  assert.equal(effectiveProfile(o).topics, DEFAULT_PROFILE.topics);
});

test("v1 db migrates: blank profile, replied->done, RR: junk, duplicates, bad rows", () => {
  const old = {
    profile: { voice: "", about: "", topics: "" },
    replies: [
      { id: "a", author: "JR5_Crypto", text: "RR:post @JR5_Crypto: Drop your sol address 1 sol", status: "new", score: 0 },
      { id: "b", author: "alice", text: "anyone building perps on onchain?", url: "https://x.com/alice/status/1234567890", status: "replied", drafts: ["x"] },
      { id: "c", author: "alice", text: "anyone building perps on onchain?", url: "https://x.com/alice/status/1234567890", status: "new" },
      { id: "d", author: "bob", text: "", status: "new" },
      null,
    ],
  };
  const db = migrate(old);
  assert.deepEqual(db.settings, {});
  assert.equal(db.posts.length, 2);
  const alice = db.posts.find((p) => p.author === "alice");
  assert.equal(alice.status, "done");
  assert.equal(alice.id, "t1234567890");
  const spam = db.posts.find((p) => p.author === "JR5_Crypto");
  assert.equal(spam.status, "filtered");
  assert.ok(!spam.text.includes("RR:"));
});

test("defaults shipped in earlier versions are not treated as user edits", () => {
  const db = migrate({ profile: { voice: "casual, sharp, short sentences, opinionated but not arrogant, no hype words, no emojis", topics: "", about: "" }, replies: [] });
  assert.deepEqual(db.settings, {});
});

test("load(): corrupt file is quarantined, missing file ok, old format migrates on disk", () => {
  const dir = tmp();
  assert.equal(load().posts.length, 0);
  writeFileSync(join(dir, "db.json"), "{not json");
  assert.equal(load().posts.length, 0);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("db.corrupt-")));
  writeFileSync(join(dir, "db.json"), JSON.stringify({ profile: { voice: "" }, replies: [{ author: "a", text: "onchain builders unite", status: "new" }] }));
  const db = load();
  assert.equal(db.v, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, "db.json"), "utf8")).v, 2);
  assert.equal(effectiveProfile(db.settings).topics, DEFAULT_PROFILE.topics);
});

test("cleanText removes counts, UI words and RR markers", () => {
  assert.equal(cleanText("RR:post @x: gm onchain\n12\nReply\n1.2K\nRepost\n3 likes"), "gm onchain");
});

test("parseClipboard: good payload, damaged, empty, no posts, layout changed, non-X text", () => {
  const ok = parseClipboard(rr1([P(1234567, "alice", "onchain perps are cooking"), P(0, "bad", "x")]));
  assert.equal(ok.posts.length, 1);
  assert.equal(ok.invalid, 1);
  assert.match(parseClipboard("RR1\n{oops").error, /damaged/);
  assert.match(parseClipboard("  ").error, /empty/);
  assert.match(parseClipboard(rr1([])).error, /No posts were visible/);
  assert.match(parseClipboard("RR1\n" + JSON.stringify({ posts: [], stats: { articles: 9 } })).error, /could not read/);
  assert.match(parseClipboard("buy my course lol").error, /look like posts/);
});

test("classify is permissive: builder posts pass, spam and junk do not", () => {
  const prof = effectiveProfile({});
  const c = (t) => classify({ text: t }, prof);
  assert.equal(c("just deployed my first anchor program").eligible, true);
  assert.equal(c("ai agents are going to eat wallets").eligible, true);
  assert.equal(c("gm").reason, "too short");
  assert.equal(c("Drop your SOL wallet, first 800 only.").reason, "spam");
  assert.equal(c("my cat did a funny thing today at the park").reason, "low relevance");
});

test("importPosts reports counts and dedupes by status id, not text", () => {
  tmp();
  const db = load();
  const prof = effectiveProfile({});
  const parsed = parseClipboard(rr1([
    P(1000001, "alice", "anyone building perps on onchain?"),
    P(1000002, "bob", "same text different id: hackathon grind"),
    P(1000003, "myhandle", "my own post about onchain"),
    P(1000004, "spammer", "Drop your SOL wallet, first 800 only."),
    P(1000005, "cat", "my cat did a funny thing today at the park"),
    P(1000001, "alice", "anyone building perps on onchain?"),
  ]));
  const r1 = importPosts(db, parsed, prof);
  assert.deepEqual([r1.found, r1.added, r1.duplicates, r1.ownSkipped], [6, 2, 1, 1]);
  assert.equal(r1.filtered.spam, 1);
  assert.equal(r1.filtered["low relevance"], 1);
  db.posts.find((p) => p.tweetId === "1000002").status = "skipped";
  const again = parseClipboard(rr1([P(1000001, "alice", "anyone building perps on onchain?"), P(1000002, "bob", "same text different id: hackathon grind")]));
  const r2 = importPosts(db, again, prof);
  assert.equal(r2.added, 0);
  assert.equal(r2.duplicates, 2, "skipped posts must not come back");
  const r3 = importPosts(db, parseClipboard(rr1([P(1000009, "carol", "anyone building perps on onchain?")])), prof);
  assert.equal(r3.added, 1, "same text with a different status id is a different post");
});

test("tidyDraft / parseDrafts: em dashes, banned phrases, hashtags, dupes, formats", () => {
  assert.equal(llm.tidyDraft('"nice — really"'), "nice, really");
  assert.equal(llm.tidyDraft("Great insights! love it"), "");
  assert.equal(llm.tidyDraft("bullish #onchain"), "bullish");
  const d = llm.parseDrafts('sure {"replies":["gm builders","gm builders!","what stack are you on?"]}');
  assert.deepEqual(d, ["gm builders", "what stack are you on?"]);
  assert.equal(llm.parseDrafts("1. lol same\n2. depends on the fees tbh").length, 2);
});

test("generation: success, transient retry, permanent failure isolated, timeout", async () => {
  tmp();
  const mock = await startMock();
  Object.assign(process.env, { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.url, LLM_RETRY_DELAY_MS: "10", LLM_TIMEOUT_MS: "300" });
  const { kick } = await import("../generator.js");
  const prof = effectiveProfile({});
  const db = load();
  importPosts(db, parseClipboard(rr1([
    P(2000001, "a", "onchain perps are cooking"),
    P(2000002, "b", "FLAKY onchain builders thread"),
    P(2000003, "c", "BROKEN onchain dev question"),
    P(2000004, "d", "HANGS onchain trading take"),
  ])), prof);
  save(db);
  mock.rules.failOnce.add("FLAKY");
  mock.rules.failAlways.add("BROKEN");
  mock.rules.hang.add("HANGS");
  kick();
  const t0 = Date.now();
  let posts;
  do { await new Promise((r) => setTimeout(r, 50)); posts = load().posts; }
  while (posts.some((p) => ["pending", "working"].includes(p.gen.state)) && Date.now() - t0 < 8000);
  const by = (id) => posts.find((p) => p.tweetId === id);
  assert.equal(by("2000001").gen.state, "ok");
  assert.equal(by("2000001").drafts.length, 2);
  assert.equal(by("2000002").gen.state, "ok", "a 503 from one model is absorbed by the next");
  assert.equal(by("2000002").gen.state, "ok");
  assert.equal(by("2000003").gen.state, "error");
  assert.match(by("2000003").gen.error, /OpenRouter error 500/);
  assert.equal(by("2000004").gen.state, "error");
  assert.match(by("2000004").gen.error, /Timed out/);
  mock.close();
});

test("parseDrafts rejects a safety-classifier answer that is not a reply", () => {
  assert.deepEqual(llm.parseDrafts("User Safety: safe"), []);
  assert.deepEqual(llm.parseDrafts("safe"), []);
  assert.deepEqual(llm.parseDrafts('{"replies":["User Safety: safe","ok"]}'), []);
});

test("model chain: a 404 model and a junk-answer model are skipped, next model is used", async () => {
  tmp();
  const mock = await startMock();
  Object.assign(process.env, { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.url, OPENROUTER_MODEL: "gone/model:free,guard/safety:free,good/chat:free", LLM_TIMEOUT_MS: "2000" });
  mock.rules.badModels.add("gone/model:free");
  mock.rules.junkModels.add("guard/safety:free");
  const { drafts, usedModel } = await llm.draftReplies({ author: "a", text: "onchain perps are cooking", kind: "post" }, effectiveProfile({}));
  assert.equal(drafts.length, 2);
  assert.equal(usedModel, "good/chat:free");
  assert.deepEqual(mock.calls.map((c) => c.model), ["gone/model:free", "guard/safety:free", "good/chat:free"]);
  delete process.env.OPENROUTER_MODEL;
  mock.close();
});

test("a bad API key fails fast with a clear message and does not try other models", async () => {
  tmp();
  const bad = (await import("node:http")).createServer((q, r) => { if (q.method === "GET") { r.writeHead(200); return r.end('{"data":[]}'); } r.writeHead(401); r.end("nope"); });
  await new Promise((r) => bad.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { OPENROUTER_API_KEY: "wrong", OPENROUTER_BASE_URL: `http://127.0.0.1:${bad.address().port}` });
  await assert.rejects(llm.draftReplies({ author: "a", text: "x onchain", kind: "post" }, effectiveProfile({})), /rejected the API key/);
  bad.close();
});

test("parseDrafts rejects echoed placeholders like first/second", () => {
  assert.deepEqual(llm.parseDrafts('{"replies":["first","second"]}'), []);
  assert.deepEqual(llm.parseDrafts('{"replies":["<reply text 1>","Reply 2"]}'), []);
});

test("free-model artifacts are cleaned or rejected: labels, meta-advice", () => {
  assert.equal(llm.tidyDraft('it\'s already chaos, ai just automates rug pulls" (punchy)'), "it's already chaos, ai just automates rug pulls");
  assert.deepEqual(llm.parseDrafts('{"replies":["Specific point/question: maybe ask what they built","you could ask about the submission process"]}'), []);
  assert.equal(llm.parseDrafts('{"replies":["shipping at 3am is the only real deadline","what did you build?"]}').length, 2);
});

test("instruction echoes are rejected by draftReplies", async () => {
  tmp();
  const mock = await startMock();
  Object.assign(process.env, { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.url, OPENROUTER_MODEL: "echo/model:free,good/chat:free" });
  mock.rules.echoModels = new Set(["echo/model:free"]);
  const { drafts, usedModel } = await llm.draftReplies({ author: "a", text: "onchain perps are cooking", kind: "post" }, effectiveProfile({}));
  assert.equal(usedModel, "good/chat:free");
  assert.equal(drafts.length, 2);
  delete process.env.OPENROUTER_MODEL;
  mock.close();
});

test("trailing model labels after a closing quote are stripped", () => {
  assert.equal(llm.tidyDraft('watch them frontrun each other" - punchy, funny'), "watch them frontrun each other");
});

test("mood and promo: validated, stored only when changed, default otherwise", () => {
  assert.deepEqual(overridesFrom({ mood: "shitpost", promo: "link" }), { mood: "shitpost", promo: "link" });
  assert.deepEqual(overridesFrom({ mood: "default", promo: "soft" }), {});
  assert.deepEqual(overridesFrom({ mood: "nonsense", promo: "spam" }), {});
  assert.equal(effectiveProfile({ mood: "nonsense" }).mood, "default");
  assert.equal(effectiveProfile({ promo: "off" }).promo, "off");
});

test("prompt carries the mood; site only when promo is on; links only in link mode", async () => {
  tmp();
  const mock = await startMock();
  Object.assign(process.env, { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.url, OPENROUTER_MODEL: "good/chat:free" });
  const post = { author: "a", text: "anyone tracking onchain perps volume?", kind: "post" };
  const sys = async (settings) => { await llm.draftReplies(post, effectiveProfile(settings)); return mock.calls.at(-1).system; };

  const plain = await sys({});
  assert.ok(!plain.includes("Mood for these replies"));
  assert.ok(!plain.includes("building this project"), "no site set = nothing to promote");

  const shit = await sys({ mood: "shitpost", site: "Acme (acme.example): perps dashboard" });
  assert.match(shit, /Mood for these replies: unhinged crypto twitter meme energy/);
  assert.match(shit, /building this project: Acme \(acme.example\)/);
  assert.match(shit, /Never include a URL/);

  assert.match(await sys({ promo: "link", site: "Acme (acme.example)" }), /include its link/);
  assert.ok(!(await sys({ promo: "off", site: "Acme (acme.example)" })).includes("building this project"));
  delete process.env.OPENROUTER_MODEL;
  mock.close();
});

test("links in a draft are rejected unless link mode is on", () => {
  const t = '{"replies":["we track exactly that at acme.io if useful","been building a perps dashboard for this, dm me"]}';
  assert.deepEqual(llm.parseDrafts(t), ["been building a perps dashboard for this, dm me"]);
  assert.equal(llm.parseDrafts(t, [], { allowLinks: true }).length, 2);
});
