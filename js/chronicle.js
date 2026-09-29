// Chronicle-wide search + "Ask the Chronicle" chat.
//
// Both features share one index: every tab's HTML fragment is fetched once,
// split into paragraph-sized passages, and each passage is tagged with its tab
// and the entry it belongs to (NPC card, session, lore entry, ...).
//
// - Search ("All tabs" button / Enter in the search box) is plain keyword
//   matching in the browser: free, instant, never makes anything up.
// - Chat picks the best-matching passages and sends only those, plus the
//   question, to the free Workers AI relay in /worker.

(function () {
    // Paste the Worker URL here after `npx wrangler deploy` (see worker/README.md).
    // While it's empty, the chat button stays hidden; search works regardless.
    const CHAT_URL = "https://barovia-chronicle.cameronwoodard1288-9d0.workers.dev";

    const ENTRY_SELECTOR = '.card, .lore-item, .codex-item, .library-item, .tl-entry';
    const STOPWORDS = new Set(('a an the and or but of to in on at by for with from is are was were be been being ' +
        'do does did what who whom whose which when where why how that this these those it its he she they them ' +
        'his her their we us our you your i me my about into than then there here has have had can could would ' +
        'should will just any all some tell know did does anything something happen happened say said').split(' '));

    // ---------- Index ----------

    let indexPromise = null;

    function tabList() {
        return Array.from(document.querySelectorAll('.tab-menu .tab-btn')).map(btn => {
            const m = (btn.getAttribute('onclick') || '').match(/loadFragment\('([^']+)'/);
            return m ? { file: m[1], label: btn.textContent.trim(), btn } : null;
        }).filter(Boolean);
    }

    function norm(s) {
        return s.replace(/\s+/g, ' ').trim();
    }

    function headingOf(el) {
        const h = el && el.querySelector('h2, h3, h4, strong');
        return h ? norm(h.textContent) : '';
    }

    async function buildIndex() {
        const passages = [];
        await Promise.all(tabList().map(async tab => {
            let html;
            try {
                const res = await fetch(`content/${tab.file}.html`);
                if (!res.ok) return;
                html = await res.text();
            } catch (e) { return; }
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll('script, style').forEach(n => n.remove());

            let lastHeading = tab.label;
            doc.body.querySelectorAll('h1, h2, h3, h4, p, li, tr').forEach(el => {
                if (/^H[1-4]$/.test(el.tagName)) { lastHeading = norm(el.textContent) || lastHeading; return; }
                if (el.querySelector('p, li, tr')) return; // index the innermost blocks only
                const text = norm(el.textContent);
                if (text.length < 25) return;
                const entry = el.closest(ENTRY_SELECTOR);
                passages.push({
                    tab: tab.file,
                    tabLabel: tab.label,
                    title: headingOf(entry) || lastHeading,
                    text,
                    lower: text.toLowerCase(),
                });
            });
        }));
        return passages;
    }

    function getIndex() {
        if (!indexPromise) indexPromise = buildIndex();
        return indexPromise;
    }

    function terms(query) {
        return Array.from(new Set(
            query.toLowerCase().replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/)
                .map(t => t.replace(/^'+|'+$/g, ''))
                .filter(t => t.length > 1 && !STOPWORDS.has(t))
        ));
    }

    function countHits(haystack, term) {
        let n = 0, i = 0;
        while ((i = haystack.indexOf(term, i)) !== -1) { n++; i += term.length; }
        return n;
    }

    // Score = term hits in the passage + a bonus for hits in its entry title.
    // requireAll: search mode wants every word present; chat mode ranks partial matches too.
    function rank(passages, ts, requireAll) {
        const scored = [];
        for (const p of passages) {
            const titleLower = p.title.toLowerCase();
            let score = 0, matched = 0;
            for (const t of ts) {
                const hits = countHits(p.lower, t) + 3 * countHits(titleLower, t);
                if (hits) { matched++; score += hits; }
            }
            if (!matched || (requireAll && matched < ts.length)) continue;
            // An entry named exactly what was searched (e.g. the "Sasha" NPC card) goes to the top.
            const exact = titleLower === ts.join(' ') ? 1000 : 0;
            scored.push({ p, score: score * matched + exact });
        }
        return scored.sort((a, b) => b.score - a.score);
    }

    // ---------- Jump to a result ----------

    // ---------- Long-card safety net ----------
    // Any plain card (no collapsible sections of its own) over ~220 words is cut
    // to a fixed height with a fade and a "Show more" button. Structured cards
    // (summary + facts + collapsed history) are skipped because they contain <details>.

    function clampLongCards() {
        document.querySelectorAll('#content-area .card').forEach(card => {
            if (card.dataset.clampChecked || card.querySelector('details') || card.classList.contains('inv-card')) return;
            card.dataset.clampChecked = '1';
            if (card.textContent.trim().split(/\s+/).length < 220) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'clamp-toggle';
            btn.textContent = 'Show more ▼';
            btn.onclick = () => setClamped(card, !card.classList.contains('is-clamped'));
            card.classList.add('is-clamped');
            card.appendChild(btn);
        });
    }

    function setClamped(card, clamped) {
        card.classList.toggle('is-clamped', clamped);
        const btn = card.querySelector(':scope > .clamp-toggle');
        if (btn) btn.textContent = clamped ? 'Show more ▼' : 'Show less ▲';
    }

    // ---------- Relevance ordering ----------
    // Denizens, Realm, Lore and Quests are re-ordered on load so the most relevant
    // entries sit on top: quests by priority first, then everything by the most
    // recent session the entry mentions ("Session 47", "Sessions 41–45", an "S47"
    // history tag, or a data-session="N" attribute). Characters and places also count
    // the latest Chronicles recap that mentions them. Entries with no session at all
    // keep their written order at the bottom. The HTML files can stay in any order.

    const RELEVANCE_TABS = {
        npcs: '.npc-row',
        locations: '.loc-row',
        quests: '.quest-row',
        lore: '.lore-item',
    };
    const QUEST_PRIORITY = {
        'Active (High Priority)': 0, 'Active (Medium Priority)': 1, 'Active (Low Priority)': 2, 'Complete': 3,
    };

    function latestSession(el) {
        // data-session="N" is an explicit tag for entries whose text names no session.
        let max = Number(el.dataset.session) || 0;
        const text = el.textContent;
        for (const m of text.matchAll(/\bSessions?\s+(\d+)(?:\s*(?:–|-|to)\s*(\d+))?/g)) {
            max = Math.max(max, Number(m[1]), Number(m[2] || 0));
        }
        el.querySelectorAll('.entry-s').forEach(tag => {
            const m = tag.textContent.match(/^S(\d+)(?:\s*[–-]\s*(\d+))?/);
            if (m) max = Math.max(max, Number(m[1]), Number(m[2] || 0));
        });
        return max;
    }

    // For a Denizens/Realm card: the latest Chronicles session whose recap mentions the
    // character or place (by any of its glossary names).
    // Built once per page load: one pass over the Chronicles recaps with the glossary regex
    // (longest name wins, so "Blue Water Inn" never counts as "Blue"), recording the latest
    // session each character/place is mentioned in.
    let mentionsPromise = null;
    function sessionMentions() {
        if (!mentionsPromise) mentionsPromise = (async () => {
            const [passages, { byName, regex }] = await Promise.all([getIndex(), getEntities()]);
            const latest = new Map();
            if (!regex) return latest;
            for (const p of passages) {
                if (p.tab !== 'sessions') continue;
                const m = p.title.match(/^Session (\d+)/);
                if (!m) continue;
                const n = Number(m[1]);
                regex.lastIndex = 0;
                for (const hit of p.text.matchAll(regex)) {
                    const ent = byName.get(hit[0]);
                    if (ent && n > (latest.get(ent.title) || 0)) latest.set(ent.title, n);
                }
            }
            return latest;
        })();
        return mentionsPromise;
    }

    async function lastMentionedSession(card) {
        return (await sessionMentions()).get(cleanTitle(headingOf(card)).title) || 0;
    }

    async function sortByRelevance(tabFile) {
        const selector = RELEVANCE_TABS[tabFile];
        if (!selector) return;
        const items = Array.from(document.querySelectorAll('#content-area ' + selector));
        if (items.length < 2) return;
        const parent = items[0].parentElement;
        const ranked = items.filter(el => el.parentElement === parent).map((el, i) => ({
            el, i,
            priority: tabFile === 'quests' ? (QUEST_PRIORITY[el.dataset.status] ?? 2) : 0,
            session: latestSession(el),
        }));
        if (tabFile === 'npcs' || tabFile === 'locations') {
            // Characters and places rank by whichever is later: the latest session their card
            // names, or the latest session recap in Chronicles that mentions them.
            await Promise.all(ranked.map(async r => { r.session = Math.max(r.session, await lastMentionedSession(r.el)); }));
        }
        ranked.sort((a, b) => a.priority - b.priority || b.session - a.session || a.i - b.i);
        // Re-append in the new order. Comments/whitespace between cards stay where they were.
        ranked.forEach(r => parent.appendChild(r.el));
    }

    // ---------- Site-wide glossary links ----------
    // Every Denizens (NPC) and Realm (location) card becomes a glossary entry.
    // After each tab loads, the first mention of each name in a paragraph gets a
    // dotted underline; clicking it shows the card's summary and a link to it.

    const GLOSSARY_SOURCES = [
        { file: 'npcs', label: 'Denizens', card: '.npc-row' },
        { file: 'locations', label: 'Realm', card: '.loc-row' },
    ];
    // Extra names people actually use in the text, keyed by the card's title.
    const EXTRA_ALIASES = {
        'Strahd von Zarovich': ['Strahd'],
        'Commander Vladimir Horngaard': ['Vladimir', 'Horngaard'],
        'Sir Godfrey Gwilym': ['Godfrey'],
        'Dr. Rudolph Van Richten': ['Van Richten', 'Rictavio', 'Rudolph van Richten'],
        'Zelly': ['Esmeralda', 'Esmeralda Davenir', "Esmeralda D'Avenir", 'Esmerelda'],
        'Ireena': ['Irena', 'Tatianna'],
        'Cyrus Belleview': ['Cyrus'],
        'Ludmilla Vilisevic': ['Ludmilla'],
        'Volenta Popofsky': ['Volenta', 'Valenta'],
        'Emil Tornesku': ['Emil'],
        'Zuleeka Tornesku': ['Zuleeka'],
        'Doru Bonavich': ['Doru'],
        'Madam Eva the Seer': ['Madam Eva', 'Madame Eva'],
        'Baba Lysaga': ['Baba Lasaga', 'Babalysaga'],
        'Lady Fiona Wachter': ['Fiona Wachter', 'Lady Wachter', 'Fiona'],
        'Stella': ['Stella Wachter'],
        'Sergei Von Zarovich': ['Sergei'],
        'Dimitri Krezkov': ['Dimitri'],
        'Anna Krezkov': ['Anna'],
        'Ilya Krezkov': ['Ilya'],
        'Vargas Vallakovich': ['Baron Vallakovich', 'Vargas'],
        'Bianca Stoyanovich': ['Bianca'],
        'Henrik Vandervoort': ['Henrik'],
        'Grigor One-Eye': ['Grigor'],
        'Gustav Durst': ['Gustav'],
        'Elizabeth Durst': ['Elizabeth'],
        'Erasmus van Richten': ['Erasmus'],
        'Biltrath Cantomere': ['Biltrath'],
        'Irwin Martikov': ['Irwin'],
        'Cloven Belleview': ['Cloven'],
        'The Abbott': ['Abbott'],
        'Krezk': ["Saint Markovia's Abbey", 'Abbey of St. Markovia', 'Abbey of Saint Markovia'],
        'Village of Barovia': ['Barovia village', 'Barovia Village'],
        'Tser Pool Encampment': ['Tser Pool'],
        'Wizards of Wine Winery': ['Wizards of Wine'],
        'Ruins of Berez': ['Berez'],
        'Old Bonegrinder Mill': ['Bonegrinder Mill', 'Old Bonegrinder'],
        'The Blood of the Vine Tavern': ['Blood of the Vine'],
        'Castle Ravenloft': ['Ravenloft'],
        'The Ancient Oak': ['ancient oak'],
        // Alternate spellings used in older session notes.
        'Isek': ['Izek', 'Isaac'],
        'Arabelle': ['Arrabelle'],
        'Morgantha': ['Morganta'],
        'Elrich': ['Elric'],
        'Stephania': ['Stefania'],
        'Aragel': ['Aragail'],
        'Esher': ['Escher', 'Asher'],
        'Anastrasya': ['Anastasia'],
        'Louvache': ['Luvash'],
        'Nikolay': ['Nikolai'],
        'Kolyan': ['Kolyan Indirovich', 'Burgomaster Indirovich'],
        'Slowdar Slodarovich': ['Szoldar'],
        'Yefgeni Kreshkin': ['Yevgeni', 'Yvgeni'],
        'Stanimir': ['Stanomir'],
        'Ophelia': ['Ophalia'],
        'Kirill': ['Kiril'],
        'Leo Delinzia': ['Leo Delirzan'],
        'King Barov von Zarovich': ['King Barov', 'Barov'],
        'King Dostron the Hellborn': ['Dostron'],
        'The Skeletal Horseman': ['skeletal horseman'],
    };
    // Aliases that overlap existing card titles are appended here rather than in the table above,
    // because the table is keyed by the card's cleaned title.
    Object.assign(EXTRA_ALIASES, {
        'Irwin Martikov': ['Irwin', 'Erwin'],
        'Zuleeka Tornesku': ['Zuleeka', 'Zeleeka'],
        'Ismark Kolyanovich': ['Ismark', 'Ismark Kalynovich'],
        'Biltrath Cantomere': ['Biltrath', 'Biltrath Cantemere', 'Cantemere'],
    });
    // Items and concepts linked to a Codex entry: term -> { codex: exact <h4> title, aliases }.
    // Characters and places come from Denizens/Realm automatically; these need to be listed.
    const CODEX_CONCEPTS = {
        'Sunsword': { codex: 'Sergei & the Sunsword', aliases: ['Sunblade'] },
        "Icon of Dawn's Grace": { codex: "Brother Marek & the Icon of Dawn's Grace" },
        'Holy Symbol of Ravenkind': { codex: 'The Holy Symbol of Ravenkind', aliases: ['Holy Symbol'] },
        'Amber Pact': { codex: "Flint's Amber Shard — Norganas & Seriac", aliases: ['Norganas', 'Seriac', 'amber shard', 'amber shards', 'Amber Shard'] },
        'soul-capture device': { codex: "Flint's Soul-Trap Device", aliases: ['soul-trap device', 'Soul-Trap Device'] },
        'vow rings': { codex: "The Vow Rings & Andral's Letter", aliases: ['vow ring'] },
        "Gargoyle's Prophecy": { codex: "The Gargoyle's Prophecy", aliases: ["gargoyle's prophecy"] },
        'Keepers of the Feather': { codex: 'The Keepers of the Feather' },
        'Order of the Silver Dragon': { codex: "The Order's Oath", aliases: ["Order's oath", "Order's Oath"] },
        'Three-Pointed Star': { codex: 'The Ladies Three & the Three-Pointed Star', aliases: ['three-pointed star', 'Ladies of the Fanes', 'the Ladies'] },
        'Tarokka reading': { codex: 'The Five-Card Reading', aliases: ['Tarokka Reading', 'five-card reading'] },
        'counter-reading': { codex: "Strahd's Counter-Reading", aliases: ['Counter-Reading', 'counter-prophecy', 'Traitor'] },
        'First Folk': { codex: 'Kavan & the Betrayal of the First Folk' },
        'Krezkov family curse': { codex: 'The Krezkov Family Curse', aliases: ['Krezk curse', 'Krezk Curse'] },
        "Arabelle's Prophecy": { codex: "Arabelle's Prophecy (Session 22)", aliases: ["Arabelle's prophecy"] },
    };

    // Names too ambiguous to link automatically.
    const NEVER_LINK = new Set(['Andral', 'Barovia']);
    // Phrases that contain a linkable name but mean something else: they're matched
    // (so the shorter name inside them isn't linked) and then left alone.
    const IGNORE_PHRASES = ['Mother Night', "Mother Night's", "Mother's Night", 'Mother & Father', 'Mother &amp; Father'];
    // The five PCs appear in nearly every paragraph; linking them would be noise.
    const GLOSS_SKIP = 'h1, h2, h3, h4, h5, h6, summary, button, select, option, a, input, textarea, ' +
        '.gloss, .entry-s, .gothic-id, .status-badge, .badge, .ov-location-badge, #chat-panel, #global-results, script, style';

    let entitiesPromise = null;

    function cleanTitle(raw) {
        // 'Zelly (Esmerelda D'Avenir)' -> 'Zelly' + alias; 'Thornboldt "Thorn" Durst' -> alias 'Thorn'
        const aliases = [];
        let t = norm(raw);
        t = t.replace(/\(([^)]*)\)/g, (_, inner) => { aliases.push(...inner.replace(/"/g, '').split('/')); return ''; });
        t = t.replace(/"([^"]+)"/g, (_, nick) => { aliases.push(nick); return ''; });
        const names = t.split('/').map(norm).filter(Boolean);
        return { title: names[0] || norm(raw), aliases: aliases.concat(names.slice(1)).map(norm).filter(Boolean) };
    }

    async function buildEntities() {
        const entities = [];
        await Promise.all(GLOSSARY_SOURCES.map(async src => {
            let html;
            try { html = await (await fetch(`content/${src.file}.html`)).text(); } catch (e) { return; }
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll(src.card).forEach(card => {
                const strong = card.querySelector('strong');
                if (!strong) return;
                const rawTitle = norm(strong.textContent);
                const { title, aliases } = cleanTitle(rawTitle);
                const summaryEl = card.querySelector('.entry-summary') || card.querySelector('p');
                let blurb = summaryEl ? norm(summaryEl.textContent) : '';
                if (blurb.length > 280) blurb = blurb.slice(0, 277).replace(/\s+\S*$/, '') + '…';
                const sub = strong.nextElementSibling && strong.nextElementSibling.tagName === 'DIV'
                    ? norm(strong.nextElementSibling.textContent) : '';
                const status = card.querySelector('.status-badge, .region-badge');
                const portrait = card.querySelector('.npc-portrait img');
                const names = [title, ...aliases];
                // Titled card names ('The Amber Temple', 'Lord Argynvost') also match without
                // the prefix. Hand-written EXTRA_ALIASES are used exactly as given.
                for (const n of [...names]) {
                    const bare = n.replace(/^(The|Lord|Lady|Sir|Commander|Dr\.|Mr\.)\s+/, '');
                    if (bare !== n && bare.length > 3) names.push(bare);
                }
                names.push(...(EXTRA_ALIASES[title] || []));
                entities.push({
                    title, rawTitle, tab: src.file, tabLabel: src.label, blurb, sub,
                    status: status ? norm(status.textContent) : '',
                    img: portrait ? portrait.getAttribute('src') : '',
                    names: [...new Set(names)].filter(n => n.length > 2 && !NEVER_LINK.has(n)),
                });
            });
        }));
        // Codex-backed items and concepts.
        try {
            const doc = new DOMParser().parseFromString(await (await fetch('content/codex.html')).text(), 'text/html');
            const byH4 = new Map();
            doc.querySelectorAll('details.codex-item').forEach(d => {
                const h4 = d.querySelector('h4');
                if (h4) byH4.set(norm(h4.textContent), d);
            });
            for (const [term, cfg] of Object.entries(CODEX_CONCEPTS)) {
                const item = byH4.get(cfg.codex);
                if (!item) continue;
                const p = item.querySelector('.codex-body-block p');
                let blurb = p ? norm(p.textContent) : '';
                if (blurb.length > 280) blurb = blurb.slice(0, 277).replace(/\s+\S*$/, '') + '…';
                const cat = item.closest('.codex-category');
                const catTitle = cat && cat.querySelector('.codex-category-header');
                entities.push({
                    title: term, rawTitle: cfg.codex, tab: 'codex', tabLabel: 'Codex', blurb,
                    sub: catTitle ? norm(catTitle.textContent) : '', status: 'Codex',
                    names: [term, ...(cfg.aliases || [])],
                });
            }
        } catch (e) { /* the codex is optional for linking */ }
        // One regex for every name, longest first so 'Blue Water Inn' beats 'Blue'.
        const byName = new Map();
        for (const p of IGNORE_PHRASES) byName.set(p, null);
        for (const e of entities) for (const n of e.names) if (!byName.has(n)) byName.set(n, e);
        const alts = [...byName.keys()].sort((a, b) => b.length - a.length)
            .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const regex = alts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
        return { entities, byName, regex };
    }

    function getEntities() {
        if (!entitiesPromise) entitiesPromise = buildEntities();
        return entitiesPromise;
    }

    async function linkGlossaryTerms() {
        const area = document.getElementById('content-area');
        const { byName, regex } = await getEntities();
        if (!regex || !area) return;

        const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, {
            acceptNode: n => (!n.nodeValue.trim() || n.parentElement.closest(GLOSS_SKIP))
                ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        const linkedIn = new WeakMap(); // block element -> Set of entity titles already linked there
        for (const node of nodes) {
            const text = node.nodeValue;
            regex.lastIndex = 0;
            if (!regex.test(text)) continue;
            const block = node.parentElement.closest('p, li, td, dd, .tl-body, div') || area;
            const owner = node.parentElement.closest(ENTRY_SELECTOR);
            const ownerHeading = owner ? norm(headingOf(owner)) : null;
            const ownerTitle = owner ? cleanTitle(ownerHeading).title : null;
            if (!linkedIn.has(block)) linkedIn.set(block, new Set());
            const done = linkedIn.get(block);

            const frag = document.createDocumentFragment();
            let last = 0, changed = false, m;
            regex.lastIndex = 0;
            while ((m = regex.exec(text))) {
                const ent = byName.get(m[0]);
                // Skip ignored phrases, repeats in this paragraph, and an entry linking to itself.
                if (!ent || done.has(ent.title) || ent.title === ownerTitle || ent.rawTitle === ownerHeading) continue;
                done.add(ent.title);
                frag.append(text.slice(last, m.index));
                const span = document.createElement('span');
                span.className = 'gloss auto-gloss';
                span.dataset.entity = ent.title;
                span.textContent = m[0];
                frag.append(span);
                last = m.index + m[0].length;
                changed = true;
            }
            if (!changed) continue;
            frag.append(text.slice(last));
            node.replaceWith(frag);
        }
    }

    function closeGlossPop() {
        const el = document.getElementById('chronicle-gloss-pop');
        if (el) el.remove();
    }

    async function openGlossPop(anchor) {
        const { entities } = await getEntities();
        const ent = entities.find(e => e.title === anchor.dataset.entity);
        if (!ent) return;
        closeGlossPop();
        const pop = document.createElement('div');
        pop.id = 'chronicle-gloss-pop';
        pop.className = 'gloss-pop';
        const head = document.createElement('div');
        head.className = 'gloss-pop-title';
        head.textContent = ent.rawTitle;
        pop.append(head);
        const meta = [ent.status, ent.sub].filter(Boolean).join(' · ');
        if (meta) {
            const m = document.createElement('div');
            m.className = 'gloss-pop-meta';
            m.textContent = meta;
            pop.append(m);
        }
        if (ent.img) {
            const thumb = document.createElement('img');
            thumb.className = 'gloss-pop-img';
            thumb.src = ent.img;
            thumb.alt = '';
            pop.append(thumb);
        }
        const body = document.createElement('div');
        body.className = 'gloss-pop-blurb';
        body.textContent = ent.blurb || 'No summary yet.';
        pop.append(body);
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'gloss-pop-link';
        link.textContent = `View full entry in ${ent.tabLabel} →`;
        link.onclick = () => { closeGlossPop(); jumpToEntity(ent); };
        pop.append(link);
        document.body.append(pop);

        const r = anchor.getBoundingClientRect();
        const w = pop.offsetWidth;
        const left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - w - 8));
        pop.style.left = left + 'px';
        pop.style.top = (r.bottom + window.scrollY + 6) + 'px';
    }

    async function jumpToEntity(ent) {
        const tab = tabList().find(t => t.file === ent.tab);
        if (!tab) return;
        await window.loadFragment(tab.file, { target: tab.btn });
        const card = Array.from(document.querySelectorAll('#content-area ' + ENTRY_SELECTOR))
            .find(c => norm(headingOf(c)) === ent.rawTitle);
        if (card) reveal(card);
    }

    document.addEventListener('click', e => {
        const g = e.target.closest && e.target.closest('.auto-gloss');
        if (g) { e.stopPropagation(); openGlossPop(g); return; }
        if (!e.target.closest || !e.target.closest('#chronicle-gloss-pop')) closeGlossPop();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeGlossPop(); });

    // index.html's loadFragment calls this after every tab load.
    window.chronicleAfterLoad = async (tabFile) => {
        closeGlossPop();
        await sortByRelevance(tabFile);   // before the first paint, so cards never visibly jump
        clampLongCards();
        // Let the tab paint first; the underlines arrive a moment later. On a tablet this
        // keeps big tabs (Denizens, Timeline) from freezing before anything shows.
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        await linkGlossaryTerms();
    };

    function reveal(el) {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (n.classList && n.classList.contains('is-clamped')) setClamped(n, false);
            if (n.tagName === 'DETAILS') n.open = true;
            if (n.classList && n.classList.contains('tl-body') && n.style.display !== 'block') {
                const header = n.previousElementSibling;
                if (header && typeof window.toggleTL === 'function') window.toggleTL(header);
                else n.style.display = 'block';
            }
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('chronicle-flash');
        setTimeout(() => el.classList.remove('chronicle-flash'), 2500);
    }

    async function jumpTo(passage) {
        const tab = tabList().find(t => t.file === passage.tab);
        if (!tab || typeof window.loadFragment !== 'function') return;
        await window.loadFragment(tab.file, { target: tab.btn });
        const probe = passage.text.slice(0, 80);
        const target = Array.from(document.querySelectorAll('#content-area p, #content-area li, #content-area tr'))
            .find(el => norm(el.textContent).startsWith(probe));
        if (target) reveal(target);
    }

    // ---------- Search UI ----------

    function highlighted(text, ts) {
        const frag = document.createDocumentFragment();
        const lower = text.toLowerCase();
        let i = 0;
        while (i < text.length) {
            let next = -1, len = 0;
            for (const t of ts) {
                const at = lower.indexOf(t, i);
                if (at !== -1 && (next === -1 || at < next)) { next = at; len = t.length; }
            }
            if (next === -1) { frag.append(text.slice(i)); break; }
            frag.append(text.slice(i, next));
            const mark = document.createElement('mark');
            mark.className = 'search-match';
            mark.textContent = text.slice(next, next + len);
            frag.append(mark);
            i = next + len;
        }
        return frag;
    }

    function snippet(p, ts) {
        const hits = ts.map(t => p.lower.indexOf(t)).filter(i => i >= 0);
        const first = hits.length ? Math.min(...hits) : 0; // title-only match: show the opening
        const start = Math.max(0, first - 90);
        const end = Math.min(p.text.length, first + 170);
        return (start > 0 ? '…' : '') + p.text.slice(start, end) + (end < p.text.length ? '…' : '');
    }

    async function runSearch() {
        const box = document.getElementById('global-results');
        const query = document.getElementById('liveSearch').value.trim();
        const ts = terms(query);
        box.hidden = false;
        box.replaceChildren();

        const head = document.createElement('div');
        head.className = 'gr-head';
        const title = document.createElement('span');
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'Close results');
        close.onclick = () => { box.hidden = true; };
        head.append(title, close);
        box.append(head);

        if (!ts.length) { title.textContent = 'Type a name or word to search every tab.'; return; }
        title.textContent = 'Searching the Chronicle…';

        const ranked = rank(await getIndex(), ts, true);
        // Group by entry so one NPC card or session shows once.
        const groups = new Map();
        for (const r of ranked) {
            const key = r.p.tab + '|' + r.p.title;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r.p);
        }
        title.textContent = groups.size
            ? `${groups.size} match${groups.size === 1 ? '' : 'es'} for “${query}” across all tabs`
            : `No matches for “${query}”.`;

        let shown = 0;
        for (const list of groups.values()) {
            if (++shown > 40) break;
            const p = list[0];
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'gr-item';
            const meta = document.createElement('div');
            meta.className = 'gr-meta';
            const tab = document.createElement('span');
            tab.className = 'gr-tab';
            tab.textContent = p.tabLabel;
            const name = document.createElement('strong');
            name.textContent = p.title;
            meta.append(tab, name);
            const snip = document.createElement('div');
            snip.className = 'gr-snip';
            snip.append(highlighted(snippet(p, ts), ts));
            item.append(meta, snip);
            item.onclick = () => { box.hidden = true; jumpTo(p); };
            box.append(item);
        }
    }

    function initSearch() {
        const input = document.getElementById('liveSearch');
        document.getElementById('global-search-btn').addEventListener('click', runSearch);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
        // Warm the index (and the relevance data built from it) in the background so the
        // first search and the first Denizens/Realm visit are instant.
        (window.requestIdleCallback || setTimeout)(() => getIndex().then(() => sessionMentions()));
    }

    // ---------- Chat UI ----------

    function initChat() {
        if (!CHAT_URL) return;
        const toggle = document.getElementById('chat-toggle');
        const panel = document.getElementById('chat-panel');
        const log = document.getElementById('chat-log');
        const form = document.getElementById('chat-form');
        const input = document.getElementById('chat-input');
        const history = [];

        toggle.hidden = false;
        toggle.addEventListener('click', () => { panel.hidden = false; toggle.hidden = true; input.focus(); });
        document.getElementById('chat-close').addEventListener('click', () => { panel.hidden = true; toggle.hidden = false; });

        function getCode(forceAsk) {
            let code = null;
            try { code = localStorage.getItem('barovia-party-code'); } catch (e) {}
            if (!code || forceAsk) {
                code = prompt('Enter the party code to ask the Chronicle:');
                if (code) { try { localStorage.setItem('barovia-party-code', code); } catch (e) {} }
            }
            return code;
        }

        function addMsg(text, cls) {
            const div = document.createElement('div');
            div.className = 'chat-msg ' + cls;
            div.textContent = text; // plain text only, never innerHTML
            log.appendChild(div);
            log.scrollTop = log.scrollHeight;
            return div;
        }

        async function retrieve(question) {
            // Include the previous question's words so follow-ups ("what about her?") still find context.
            const prev = [...history].reverse().find(m => m.role === 'user');
            const ts = terms(question + ' ' + (prev ? prev.content : ''));
            if (!ts.length) return [];
            const picked = [];
            let budget = 13000;
            for (const { p } of rank(await getIndex(), ts, false)) {
                if (p.text.length > budget) continue;
                picked.push({ tab: p.tabLabel, title: p.title, text: p.text });
                budget -= p.text.length;
                if (budget < 300 || picked.length >= 25) break;
            }
            return picked;
        }

        async function ask(question, retried) {
            const code = getCode(retried);
            if (!code) return null;
            let res;
            try {
                res = await fetch(CHAT_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Party-Code': code },
                    body: JSON.stringify({ question, history, passages: await retrieve(question) }),
                });
            } catch (e) {
                // Network failure or the relay refusing this page's address (CORS).
                throw new Error("Couldn't reach the Keeper. Check your connection. If you're testing a copy of the site, the relay only answers the GitHub site and localhost/127.0.0.1 test servers.");
            }
            if (res.status === 403) throw new Error('The Keeper only answers questions from the Chronicle site itself.');
            const data = await res.json().catch(() => ({}));
            if (res.status === 401 && !retried) {
                addMsg('That party code was wrong. Try again.', 'chat-error');
                return ask(question, true);
            }
            if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
            return data.answer;
        }

        form.addEventListener('submit', async e => {
            e.preventDefault();
            const q = input.value.trim();
            if (!q) return;
            input.value = '';
            addMsg(q, 'chat-user');
            const btn = form.querySelector('button');
            btn.disabled = true;
            const thinking = addMsg('Consulting the Chronicle…', 'chat-bot');
            try {
                const answer = await ask(q, false);
                thinking.remove();
                if (answer) {
                    addMsg(answer, 'chat-bot');
                    history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
                }
            } catch (err) {
                thinking.remove();
                addMsg(err.message, 'chat-error');
            } finally {
                btn.disabled = false;
                input.focus();
            }
        });
    }

    initSearch();
    initChat();
})();
