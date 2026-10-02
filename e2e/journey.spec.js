import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "../tests/mock-openrouter.js";

const FIXTURE = readFileSync(new URL("./fixtures/x-search.html", import.meta.url), "utf8");
const CLIP = ["clipboard-read", "clipboard-write"];
let app, fixture, mock, appUrl, fixtureUrl, dataDir;

test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "rr-e2e-"));
  // An OLD-format db with blank settings and a leftover junk row, exactly the situation that broke before.
  writeFileSync(join(dataDir, "db.json"), JSON.stringify({
    profile: { voice: "", about: "", topics: "" },
    replies: [
      { id: "x1", author: "oldfriend", text: "RR:post @oldfriend: gm onchain builders", url: "https://x.com/oldfriend/status/1800000000000000001", status: "replied", drafts: ["gm"] },
      { id: "x2", author: "unknown", text: "RR:post", status: "new" },
    ],
  }));
  mock = await startMock();
  Object.assign(process.env, {
    DATA_DIR: dataDir, MY_HANDLE: "myhandle", OPENROUTER_API_KEY: "test-key", OPENROUTER_BASE_URL: mock.url,
    OPENROUTER_MODEL: "mock/free-model", LLM_RETRY_DELAY_MS: "20", LLM_TIMEOUT_MS: "3000",
  });
  const { createApp } = await import("../server.js");
  app = createApp();
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${app.address().port}`;
  fixture = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(FIXTURE); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}/search?q=onchain`;
});
test.afterAll(() => { app?.close(); fixture?.close(); mock?.close(); });

/** Run the real bookmarklet code (decoded from the link in the app) on the fixture X page. */
async function runBookmarklet(appPage, xPage) {
  const href = await appPage.locator("#bm").getAttribute("href");
  const code = decodeURIComponent(href.slice("javascript:".length));
  await xPage.bringToFront();
  await xPage.evaluate(code);
  await expect(xPage.locator("[data-rr-toast]")).toContainText("copied");
  return xPage.evaluate(() => navigator.clipboard.readText());
}
const cards = (page) => page.locator("#list .card");

test.describe.serial("full local journey", () => {
  let context, appPage, xPage;

  test("blank/old settings get defaults and old db migrates without deleting anything", async ({ browser }) => {
    context = await browser.newContext();
    await context.grantPermissions(CLIP, { origin: appUrl });
    await context.grantPermissions(CLIP, { origin: new URL(fixtureUrl).origin });
    await context.route("https://x.com/**", (r) => r.fulfill({ body: "<title>fake x</title>", contentType: "text/html" }));
    appPage = await context.newPage();
    await appPage.goto(appUrl);
    await expect(appPage.locator("#ready")).toHaveText("Nothing in the queue yet");
    await appPage.locator("summary", { hasText: "Settings" }).click();
    await expect(appPage.locator("#topics")).toHaveValue(/crypto trading.*hackathon/);
    await expect(appPage.locator("#voice")).toHaveValue(/casual builder crypto twitter/);
    await expect(appPage.locator("#about")).toHaveValue(/a builder posting about trading/);
    await appPage.getByRole("link", { name: /^done 1$/ }).click();
    await expect(cards(appPage)).toHaveCount(1);
    await expect(appPage.locator("#list")).toContainText("gm onchain builders");
    await expect(appPage.locator("#list")).not.toContainText("RR:");
    await appPage.getByRole("link", { name: /back to queue/ }).click();
  });

  test("bookmarklet extracts clean posts from an X-like page", async () => {
    xPage = await context.newPage();
    await xPage.goto(fixtureUrl);
    const clip = await runBookmarklet(appPage, xPage);
    expect(clip).toMatch(/^RR1\r?\n/); // Windows clipboards turn \n into \r\n
    const payload = JSON.parse(clip.slice(3));
    expect(payload.stats).toMatchObject({ articles: 9, extracted: 6, ads: 1, failed: 1 });
    const byId = Object.fromEntries(payload.posts.map((p) => [p.id, p]));
    expect(Object.keys(byId)).toHaveLength(6);
    expect(byId["1900000000000000001"]).toMatchObject({ handle: "alice", name: "Alice Dev" });
    expect(byId["1900000000000000001"].text).toBe("anyone building perps on onchain? thinking about the margin engine");
    expect(byId["1900000000000000002"].text).not.toContain("QUOTED");
    expect(byId["1900000000000000003"].handle).toBe("carol");
    for (const p of payload.posts) {
      expect(p.text).not.toMatch(/\b(Reply|Repost|Like|Views)\b|1\.2K|RR:/);
    }
  });

  test("Import shows exact counts and immediately renders cards, replies get written", async () => {
    await appPage.bringToFront();
    await appPage.locator("#import").click();
    await expect(appPage.locator("#report")).toContainText("6 found · 3 added · 1 skipped (my own post) · 1 spam filtered · 1 low relevance filtered");
    await expect(appPage.locator("#ready")).toHaveText("3 posts ready");
    await expect(cards(appPage)).toHaveCount(3);
    await expect(appPage.locator("textarea.reply")).toHaveCount(3, { timeout: 10_000 });
    for (const v of await appPage.locator("textarea.reply").evaluateAll((els) => els.map((e) => e.value)))
      expect(v).toMatch(/first take/);
    // The filtered/own/ad posts never became cards.
    await expect(appPage.locator("#list")).not.toContainText("Drop your SOL wallet");
    await expect(appPage.locator("#list")).not.toContainText("cat did a funny");
    await expect(appPage.locator("#list")).not.toContainText("The wait is almost over");
    // Highest-priority (question) post first.
    await expect(cards(appPage).first()).toContainText("@alice");
  });

  test("Other version, edit, Skip", async () => {
    const first = cards(appPage).first();
    const ta = first.locator("textarea.reply");
    await first.getByRole("button", { name: "Other version" }).click();
    await expect(ta).toHaveValue(/whats the catch/);
    await first.getByRole("button", { name: "Other version" }).click();
    await expect(ta).toHaveValue(/first take/);
    const bob = cards(appPage).filter({ hasText: "@bob" });
    await bob.getByRole("button", { name: "Skip" }).click();
    await expect(cards(appPage)).toHaveCount(2);
    await expect(appPage.locator("#ready")).toHaveText("2 posts ready");
  });

  test("Open on X: copies reply, opens the EXACT status, does NOT mark done until confirmed", async () => {
    const alice = cards(appPage).filter({ hasText: "@alice" });
    await alice.locator("textarea.reply").fill("my edited reply about perps");
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      alice.getByRole("button", { name: "Copy reply + Open on X" }).click(),
    ]);
    expect(popup.url()).toBe("https://x.com/alice/status/1900000000000000001");
    await appPage.bringToFront();
    expect(await appPage.evaluate(() => navigator.clipboard.readText())).toBe("my edited reply about perps");
    await expect(cards(appPage)).toHaveCount(2);                       // still in the queue
    await expect(alice).toContainText("press Done");
    await expect(alice.locator("textarea.reply")).toHaveValue("my edited reply about perps"); // edit survived re-render
    await alice.getByRole("button", { name: "Done, I posted it" }).click();
    await expect(cards(appPage)).toHaveCount(1);
    await popup.close();
  });

  test("importing the same search again adds nothing, regenerates nothing, resurrects nothing", async () => {
    const callsBefore = mock.calls.length;
    const clip = await runBookmarklet(appPage, xPage);
    await appPage.bringToFront();
    await appPage.locator("#import").click();
    await expect(appPage.locator("#report")).toContainText("6 found · 0 added · 5 duplicate · 1 skipped (my own post)");
    await expect(cards(appPage)).toHaveCount(1);
    await expect(appPage.locator("#list")).toContainText("@carol");
    await appPage.waitForTimeout(500);
    expect(mock.calls.length).toBe(callsBefore);
    expect(clip.startsWith("RR1")).toBe(true);
  });

  test("a failing reply shows the real error + Retry and does not block other cards", async () => {
    mock.rules.failAlways.add("BROKENPOST");
    const payload = "RR1\n" + JSON.stringify({ rr: 1, page: "search", stats: { articles: 2 }, posts: [
      { id: "1900000000000000101", handle: "eve", name: "Eve", text: "BROKENPOST onchain dev question, anyone?" },
      { id: "1900000000000000102", handle: "frank", name: "Frank", text: "onchain validators are underrated honestly" },
    ] });
    // Use the paste-box path on purpose (the clipboard path is covered above).
    await appPage.evaluate(() => { document.getElementById("manual").style.display = "block"; });
    await appPage.locator("#manualText").fill(payload);
    await appPage.locator("#manualGo").click();
    const eve = cards(appPage).filter({ hasText: "@eve" });
    await expect(eve).toContainText("Could not write a reply", { timeout: 10_000 });
    await expect(eve).toContainText("OpenRouter error 500");
    await expect(cards(appPage).filter({ hasText: "@frank" }).locator("textarea.reply")).toHaveValue(/first take/);
    mock.rules.failAlways.clear();
    await eve.getByRole("button", { name: "Retry" }).click();
    await expect(eve.locator("textarea.reply")).toHaveValue(/first take/, { timeout: 10_000 });
  });

  test("mood and site controls change how the next replies are written", async () => {
    await appPage.locator("#mood").selectOption("shitpost");
    await expect(appPage.locator("#report")).toContainText("Saved");
    await expect(appPage.locator("#ctlHint")).toContainText("Add your site");
    await appPage.reload();
    await expect(appPage.locator("#mood")).toHaveValue("shitpost");

    const frank = cards(appPage).filter({ hasText: "@frank" });
    let before = mock.calls.length;
    await frank.getByRole("button", { name: "Rewrite" }).click();
    await expect.poll(() => mock.calls.length).toBeGreaterThan(before);
    const sys1 = mock.calls.at(-1).system;
    expect(sys1).toContain("unhinged crypto twitter meme energy");
    expect(sys1).not.toContain("building this project");

    await appPage.locator("summary", { hasText: "Settings" }).click();
    await appPage.locator("#site").fill("Acme (acme.example): a perps dashboard");
    await appPage.locator("#save").click();
    await expect(appPage.locator("#ctlHint")).not.toContainText("Add your site");
    await expect(frank.locator("textarea.reply")).toBeVisible({ timeout: 10_000 });
    before = mock.calls.length;
    await frank.getByRole("button", { name: "Rewrite" }).click();
    await expect.poll(() => mock.calls.length).toBeGreaterThan(before);
    expect(mock.calls.at(-1).system).toContain("building this project: Acme (acme.example)");

    await appPage.locator("#promo").selectOption("off");
    await expect(frank.locator("textarea.reply")).toBeVisible({ timeout: 10_000 });
    before = mock.calls.length;
    await frank.getByRole("button", { name: "Rewrite" }).click();
    await expect.poll(() => mock.calls.length).toBeGreaterThan(before);
    expect(mock.calls.at(-1).system).not.toContain("building this project");
  });

  test("diagnostics explain what happened", async () => {
    await appPage.locator("summary", { hasText: "Diagnostics" }).click();
    const d = appPage.locator("#diag");
    await expect(d).toContainText("Model: mock/free-model");
    await expect(d).toContainText("OpenRouter key: found");
    await expect(d).toContainText("Last import");
    await expect(d).toContainText("Migrated db.json");
  });

  test("settings: intentional edit persists across reload; blank returns to default", async () => {
    await appPage.locator("#voice").fill("pure degen shitposter");
    await appPage.locator("#save").click();
    await appPage.reload();
    await appPage.locator("summary", { hasText: "Settings" }).click();
    await expect(appPage.locator("#voice")).toHaveValue("pure degen shitposter");
    await expect(appPage.locator("#topics")).toHaveValue(/crypto trading/);
    await appPage.locator("#defaults").click();
    await expect(appPage.locator("#voice")).toHaveValue(/casual builder crypto twitter/);
  });

  test("clipboard blocked: visible fallback box, paste + Import still works", async ({ browser }) => {
    const ctx = await browser.newContext(); // no clipboard permission
    const page = await ctx.newPage();
    await page.goto(appUrl);
    await page.locator("#import").click();
    await expect(page.locator("#manual")).toBeVisible();
    await expect(page.locator("#manualWhy")).toContainText(/blocked|empty/i);
    const payload = "RR1\n" + JSON.stringify({ rr: 1, page: "search", stats: { articles: 1 }, posts: [
      { id: "1900000000000000201", handle: "gina", name: "Gina", text: "who else is building on onchain this weekend?" },
    ] });
    await page.locator("#manualText").fill(payload);
    await page.locator("#manualGo").click();
    await expect(page.locator("#report")).toContainText("1 found · 1 added");
    await expect(cards(page).filter({ hasText: "@gina" })).toHaveCount(1);
    await ctx.close();
  });

  test("garbage on the clipboard is refused with a clear message", async () => {
    await appPage.evaluate(() => navigator.clipboard.writeText("buy my course lol"));
    await appPage.locator("#import").click();
    await expect(appPage.locator("#report")).toContainText("doesn't look like posts copied from X");
  });
});
