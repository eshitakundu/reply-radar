# Reply Radar

A small local tool that helps you grow on X by replying faster and better, at zero cost.

It finds posts worth replying to, writes reply drafts with a free LLM, and lines them up as a queue. For each card you click **Open on X** and press Post yourself. Nothing is posted automatically.

## How it works

1. **Collect:** a bookmarklet copies the posts visible on an X page (a search, or one of your own posts) to the clipboard.
2. **Import:** the app reads the clipboard, validates and de-duplicates the posts, and drops spam, your own posts, and low-relevance ones.
3. **Draft:** each remaining post is sent to a free OpenRouter model, which writes replies in your voice. Several models are tried in turn if one is busy.
4. **Review:** you get a queue of cards. Edit if you like, click **Open on X**, and post.

## Run it

```
npm install        # only needed for the browser tests
cp .env.example .env   # add OPENROUTER_API_KEY (free at openrouter.ai/keys)
npm start          # http://localhost:3000
```

Topics, voice, mood and what to say about your own project are editable under Settings.

## Structure

| File | Purpose |
|------|---------|
| `server.js` | HTTP server and JSON API |
| `importer.js` | Parse clipboard text, clean, score, filter, de-duplicate |
| `generator.js` | Background queue that writes drafts for new posts |
| `llm.js` | OpenRouter client, prompt, and draft cleanup |
| `models.js` | Picks working free models and falls back between them |
| `store.js` | JSON file storage with migration from older formats |
| `defaults.js` | Default settings, moods, and schema version |
| `public/index.html` | The single-page UI and the bookmarklet |
| `tests/` | Unit tests (`npm test`) |
| `e2e/` | Browser journey tests with Playwright (`npm run e2e`) |

## Notes

- Data lives in `data/db.json` on your machine and is never committed.
- X's API is paid for reading and posting, so this tool avoids it and keeps you in control of every post.
