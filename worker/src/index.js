// Barovia Chronicle Q&A relay (Cloudflare Worker, Workers AI free tier).
//
// The site's chat widget finds the passages most relevant to a question
// (using the same index as the site-wide search) and posts them here with the
// question. This worker asks a free Workers AI model to answer ONLY from those
// passages. No API key or billing is involved: the AI binding runs on
// Cloudflare's free daily allowance and simply errors once that's used up.
//
// Secret (set with `npx wrangler secret put PARTY_CODE`):
//   PARTY_CODE - shared passphrase the players type once in the widget
// Vars (wrangler.toml): ALLOWED_ORIGIN, MODEL

const MAX_QUESTION = 500;
const MAX_HISTORY = 4;          // earlier turns kept for follow-up questions
const MAX_TURN_CHARS = 1500;
const MAX_PASSAGE_CHARS = 14000; // total excerpt budget per question

const INSTRUCTIONS = `You are the Keeper of the Barovia Campaign Chronicle, a helper for players in a Curse of Strahd D&D campaign.

You are given EXCERPTS from the campaign's website. Answer using ONLY those excerpts.
- If the excerpts don't contain the answer, say "The Chronicle doesn't seem to record that. Try the search box." Do not guess, and do not use general Curse of Strahd knowledge: this campaign differs from the published module.
- If an excerpt says something is uncertain, a theory, or unconfirmed, keep that uncertainty.
- Mention which tab the answer comes from (e.g. "per the Denizens tab").
- Be concise: a short paragraph or a few bullet points.`;

// The live site, plus local test servers (VS Code Live Server, etc.) so the site
// can be tried out before pushing. The party code still guards every request.
function allowedOrigin(origin, env) {
  if (origin === env.ALLOWED_ORIGIN) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "")) return origin;
  return null;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Party-Code",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function buildExcerpts(passages) {
  if (!Array.isArray(passages)) return "";
  let out = "";
  for (const p of passages) {
    const block = `[${str(p?.tab, 60)} — ${str(p?.title, 150)}]\n${str(p?.text, 4000)}\n\n`;
    if (out.length + block.length > MAX_PASSAGE_CHARS) break;
    out += block;
  }
  return out.trim();
}

function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }))
    .slice(-MAX_HISTORY);
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request.headers.get("Origin"), env);
    const replyTo = origin || env.ALLOWED_ORIGIN;
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(replyTo) });
    }
    if (request.method !== "POST") return json({ error: "POST only" }, 405, replyTo);
    if (!origin) return json({ error: "Forbidden" }, 403, replyTo);
    // trim(): tolerate a stray space/newline/BOM on either the typed code or the stored secret.
    const expected = (env.PARTY_CODE || "").trim();
    if (!expected || (request.headers.get("X-Party-Code") || "").trim() !== expected) {
      return json({ error: "bad_code" }, 401, replyTo);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, replyTo);
    }
    const question = str(body.question, MAX_QUESTION).trim();
    if (!question) return json({ error: "No question" }, 400, replyTo);

    const excerpts = buildExcerpts(body.passages);
    const messages = [
      { role: "system", content: INSTRUCTIONS },
      ...cleanHistory(body.history),
      {
        role: "user",
        content: `CHRONICLE EXCERPTS:\n\n${excerpts || "(no matching excerpts found)"}\n\nQUESTION: ${question}`,
      },
    ];

    try {
      const result = await env.AI.run(env.MODEL, { messages, max_tokens: 700 });
      const answer = (result && typeof result.response === "string" ? result.response : "").trim();
      return json({ answer: answer || "The Keeper has nothing to say to that." }, 200, replyTo);
    } catch (error) {
      // Most commonly: the free daily Workers AI allowance is used up.
      console.error(error);
      return json(
        { error: "The Keeper is resting (the free daily AI allowance may be used up). Try again tomorrow, or use the search box." },
        503,
        replyTo,
      );
    }
  },
};
