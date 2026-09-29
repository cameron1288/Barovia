# Barovia Campaign Chronicle

A static site (GitHub Pages: https://cameron1288.github.io/Barovia/) tracking a *Curse of Strahd* D&D campaign.
`index.html` is a tab shell that `fetch()`es one fragment per tab from `content/*.html` into `#content-area`.
Shared behaviour lives in `js/chronicle.js`; styles in `css/style.css`. There is no build step.

This campaign departs from the published module in many places (its own NPCs, geography, spellings, timeline).
**The site's own records and the players' testimony always outrank general Curse of Strahd module knowledge.**

## Updating after a session

Sessions are recorded on **Plaud** (use the Plaud MCP tools: `list_files`, `get_note`, `get_transcript`).
The recording's AI summary is useful for orientation but gets names and attributions wrong. Work from the
transcript (`transaction_polish` block, paged 500 utterances at a time; results are large, so save and read in chunks).

**Plaud speaker labels are unreliable for this group.** Identify speakers from context, not labels:
- The player of **Flint** is Cameron (the site owner). He introduces himself in-game as "Flint Cogsworth."
- Strahd/NPCs address **Spiggot** by name; Spiggot is the "barbarian who died more than once" (past-life memory).
- **Ripley** (Jon): Strahd invited "Ripley" to ride with him; the half-orc wild card.
- **Mel** (Paul): cleric, carries the Holy Symbol of Ravenkind. **Vel** (Jocelyn): bard.
- The DM (Martin) voices all NPCs. His AI-narrated "Previously in Barovia" recap opens each session.
When an attribution is still ambiguous, write the site text neutrally and ask the user.

A full update touches: **Chronicles** (`sessions.html`, new session at the top), **Timeline**, **Denizens**, **Realm**,
**Quests**, **Lore**, **Codex**, **Companions**, **Inventory**, **Overview**, and sometimes **Combat** and the **Map** popup text.

## Conventions

- **Long cards use the structured layout.** Don't append paragraphs. Use a `p.entry-summary` (1–2 sentences),
  a `ul.entry-facts` (what matters now; keep current by replacing bullets), and collapsed `details.entry-more`
  sections whose `ul.entry-log` items start with `<span class="entry-s">S47</span>`. Add each session's events
  as a new tagged history bullet, and refresh the summary and facts. Short cards (under ~150 words) can stay plain prose.
- **Every entry needs a session number.** Denizens, Realm, Quests, and Lore auto-sort by relevance on load
  (`sortByRelevance` in `chronicle.js`): quests by `data-status` priority, then everything by the latest session
  the entry mentions ("Session 47", an `S47` tag, or a `data-session="47"` attribute). Characters and places also
  count the latest Chronicles recap that names them. An entry with no session number sinks to the bottom, so
  add `data-session` when the text wouldn't naturally name one. Card order inside the HTML doesn't matter.
- **Every named NPC gets a Denizens card** (`.npc-row`). Every card's name, and any extra aliases in
  `EXTRA_ALIASES` in `chronicle.js`, becomes a site-wide glossary link automatically. Add aliases there when the
  text uses a nickname or short form. Story-within-a-story characters (e.g. from Rictavio's tall tale) don't get cards.
- **Canonical spellings** (the text should use these; older variants stay only as glossary aliases):
  Isek, Baba Lysaga, Arabelle, Esmeralda D'Avenir, Van Richten, Morgantha, Aragel, Esher, Anastrasya, Kirill,
  Zuleeka, Leo Delinzia, Irwin, Elrich, Stephania, Louvache, Nikolay, Vallaki, Spiggot, Ireena, Soldav, Stanimir,
  Biltrath Cantomere, Ismark Kolyanovich, "Winter Splinter", Cyrus Belleview ("Sirus" was a typo; never use it).
- **Overview "Goals for Next Session"** is a short checklist of party goals actionable next session only.
  Long-term quests (e.g. the Search for Mother) stay on Quests; obvious items ("get out alive") are left out;
  single-PC reminders (e.g. Vel's cryptic boon) go in the "Keep In Mind" chips.
- **Quest status** is a fixed label (`span.status-select` plus the card's `data-status`), not an editable control.
- **Map pins:** verify placement precisely against the map image (use a percentage grid overlay; roads are dotted
  lines, rivers are solid wavy lines). Don't resolve ambiguous placement from module lore.

## Other pieces

- **Search** ("🔎 All tabs") and the **Ask the Chronicle** chat both use the paragraph index built in `chronicle.js`.
- **Chat relay:** `worker/` is a Cloudflare Worker (free Workers AI) at
  `https://barovia-chronicle.cameronwoodard1288-9d0.workers.dev`. Redeploy with `npx --yes wrangler@3 deploy` from
  `worker/`. Use wrangler 3, since this PC runs Node 20. Never run `npm install` inside this Google Drive folder:
  Drive corrupts `node_modules`. See `worker/README.md` for the party code and model settings.
- **Media:** keep audio as MP3 and portraits small (JPEG/WebP). This site is used on phones and tablets.
- **Installable app (PWA):** `manifest.webmanifest`, `sw.js`, and `icons/` let players "Add to Home Screen".
  `sw.js` serves pages from an on-device cache, then re-checks GitHub in the background and shows a
  "tap to refresh" notice when something changed. So pushed updates reach app users on their next launch,
  with no version bump needed. If you add a new tab's content file, add it to the `SHELL` list in `sw.js` so it
  works offline from the first launch. Bump `VERSION` in `sw.js` only if the caching logic itself changes.
- **Performance:** tabs are tuned to open quickly on a tablet-speed processor. Expensive work (the search index,
  the glossary entity list, the relevance "last mentioned" map) is built once per page load and reused, so
  don't add per-card or per-tab loops that rescan every page.
