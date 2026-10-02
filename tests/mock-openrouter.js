// Fake OpenRouter for tests. Replies depend on the post text so tests can tell drafts apart.
import { createServer } from "node:http";

export async function startMock() {
  const calls = [];
  const rules = { failOnce: new Set(), failAlways: new Set(), hang: new Set(), badModels: new Set(), junkModels: new Set() };
  const server = createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [] })); }
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const user = body.messages?.at(-1)?.content || "";
    calls.push({ auth: req.headers.authorization, user, model: body.model, system: body.messages?.[0]?.content || "" });
    if (rules.badModels.has(body.model)) { res.writeHead(404); return res.end("no such model"); }
    if (rules.junkModels.has(body.model)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "User Safety: safe" } }] })); }
    if (rules.echoModels?.has(body.model)) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ replies: ["Real person on crypto twitter", "1-2 short sentences, under 200 chars"] }) } }] })); }
    const key = [...rules.failAlways].find((k) => user.includes(k));
    const once = [...rules.failOnce].find((k) => user.includes(k));
    const hang = [...rules.hang].find((k) => user.includes(k));
    if (hang) return; // never answers, exercises the timeout
    if (key) { res.writeHead(500); return res.end("boom"); }
    if (once) { rules.failOnce.delete(once); res.writeHead(503); return res.end("try again"); }
    const tag = (user.match(/"""\n([\s\S]*?)\n"""/)?.[1] || "").slice(0, 24).replace(/\W+/g, " ").trim();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: body.model || "mock/free-model",
      choices: [{ message: { content: JSON.stringify({ replies: [`lol ${tag} first take`, `wait, whats the catch here honestly?`] }) } }],
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, rules, close: () => server.close() };
}
