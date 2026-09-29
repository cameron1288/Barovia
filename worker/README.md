# Ask the Chronicle — free AI chat relay

The "🦇 Ask the Chronicle" chat on the site works in two steps. First, the site finds the
passages most relevant to a question, using the same index as the "All tabs" search. Then
it sends the question and those passages here. This Cloudflare Worker asks a free
open-source model (Workers AI) to answer **only** from those passages.

**Cost: $0.** It uses Cloudflare's free daily Workers AI allowance and needs no credit
card and no API key. When the day's allowance runs out, the chat says so and starts
working again the next day. The site search keeps working either way.

**Live at:** https://barovia-chronicle.cameronwoodard1288-9d0.workers.dev (`CHAT_URL` in
`js/chronicle.js`). It only accepts requests from https://cameron1288.github.io that carry
the party code.

## Redeploying after a change

Run these from this `worker` folder. Two things to know:

- **Don't run `npm install` here.** This folder syncs to Google Drive, and Drive corrupts
  and chokes on the thousands of dependency files. `npx` runs the tool from npm's own cache
  instead.
- **Use wrangler 3 (`wrangler@3`).** Wrangler 4 needs Node.js 22, and this PC has Node 20.

```
npx --yes wrangler@3 deploy                        # after editing src/index.js or wrangler.toml
npx --yes wrangler@3 login                         # only if Cloudflare asks you to log in again
```

**Changing the party code:** write `{ "PARTY_CODE": "new-code" }` to a temporary JSON file
*outside* this folder, then run `npx --yes wrangler@3 secret bulk <that file>` and delete the
file. Don't pipe the code into `wrangler secret put` from PowerShell: it garbles the value.

## Settings

- **Model:** `MODEL` in `wrangler.toml`. The free allowance is 10,000 neurons a day, and it
  resets at 00:00 UTC (8 PM Eastern in summer, 7 PM in winter). The 70B Llama gives the best
  free answers, at about 150 neurons per question, so roughly 65 questions a day. If that runs
  out too fast, switch to `@cf/meta/llama-3.1-8b-instruct-fp8-fast` (about 25 neurons, roughly
  400 a day, weaker answers), then redeploy.
- **New tabs** are picked up automatically, because the index reads the tab buttons in
  `index.html`.
