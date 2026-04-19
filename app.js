/* Caïssa · Player Card
 *
 * Loads a player profile from two sources in parallel:
 *   - chess.org.il (Israeli Chess Federation) — HTML scraped via a public
 *     CORS proxy and parsed with DOMParser.
 *   - chess.com    — JSON from the public /pub/player API (CORS-enabled).
 *
 * The Classical rating history shown in the trajectory chart is
 * reconstructed from the ICF tournament table by walking the rating-change
 * deltas backward from the current rating — chess.org.il does not expose a
 * time series directly, and this is the only way to render a real chart.
 */

const DEFAULT_ICF_ID = "207079";
const DEFAULT_CHESSCOM_USER = "silverbullet20000";

// Public CORS proxies for chess.org.il, tried in order.
const PROXIES = [
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://cors.isomorphic-git.org/${url}`,
];
const PROXY_TIMEOUT_MS = 8000;

const els = {
  form: document.getElementById("player-form"),
  icfInput: document.getElementById("player-id"),
  chesscomInput: document.getElementById("chesscom-user"),
  status: document.getElementById("status"),

  heroId: document.getElementById("hero-id"),
  heroFide: document.getElementById("hero-fide-id"),
  heroName: document.getElementById("hero-display-name"),
  heroTitles: document.getElementById("hero-titles"),
  heroBio: document.getElementById("hero-bio"),
  peakLabel: document.getElementById("peak-label"),
  peakValue: document.getElementById("peak-value"),
  peakSub: document.getElementById("peak-sub"),

  icfRow: document.getElementById("ratings-row-icf"),
  icfMeta: document.getElementById("icf-meta"),
  comRow: document.getElementById("ratings-row-com"),
  comMeta: document.getElementById("com-meta"),

  trajectorySub: document.getElementById("trajectory-sub"),
  chartSvg: document.getElementById("chart-svg"),
  chartToolbar: document.getElementById("chart-toolbar"),
  chartEmpty: document.getElementById("chart-empty"),

  ledgerThead: document.getElementById("ledger-thead"),
  ledgerTbody: document.getElementById("ledger-tbody"),
  ledgerEmpty: document.getElementById("ledger-empty"),
  ledgerCount: document.getElementById("ledger-count"),
  search: document.getElementById("tournament-search"),

  sourceLinks: document.getElementById("source-links"),
  raw: document.getElementById("raw-json"),

  // Games page
  gamesPage: document.getElementById("games-page"),
  gamesSearch: document.getElementById("games-search"),
  gamesSummary: document.getElementById("games-summary"),
  gamesBody: document.getElementById("games-body"),
  gamesSub: document.getElementById("games-sub"),
  gamesYearFilter: document.getElementById("games-year-filter"),
  gamesSort: document.getElementById("games-sort"),
  navLinks: document.querySelectorAll(".topbar nav a[data-page]"),
};

// Profile-only sections that should be hidden when the Games page is active.
const PROFILE_SECTIONS = [
  document.querySelector(".hero"),
  document.getElementById("icf-block"),
  document.getElementById("com-block"),
  document.getElementById("trajectory-section"),
  document.querySelector(".ledger"),
];

const state = {
  icfId: DEFAULT_ICF_ID,
  chesscomUser: DEFAULT_CHESSCOM_USER,
  icf: null,
  chesscom: null,
  range: "all",
  page: "profile",
  games: null,         // { loading, error, data, aggregated, byIcfId }
  gamesExpanded: new Set(),
  gamesYear: "all",    // "all" | "2026" | "2025" | …
  gamesSort: "recent", // "recent" | "played" | "rating"
};

/* ================= BOOT ================= */

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const icfId = (els.icfInput.value || "").trim();
  const chesscomUser = (els.chesscomInput.value || "").trim();
  if (icfId && !/^\d+$/.test(icfId)) {
    setStatus("מספר שחקן באיגוד חייב להיות מספרי.", "error");
    return;
  }
  updateHash(icfId, chesscomUser);
  state.icfId = icfId;
  state.chesscomUser = chesscomUser;
  load();
});

els.search.addEventListener("input", renderLedger);

els.chartToolbar.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-range]");
  if (!btn) return;
  [...els.chartToolbar.querySelectorAll("button")].forEach((b) =>
    b.classList.toggle("active", b === btn)
  );
  state.range = btn.dataset.range;
  renderChart();
});

els.navLinks.forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(a.dataset.page);
  });
});

els.gamesSearch.addEventListener("input", renderGames);

els.gamesYearFilter.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-year]");
  if (!btn) return;
  state.gamesYear = btn.dataset.year;
  renderGames();
});

els.gamesSort.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-sort]");
  if (!btn) return;
  state.gamesSort = btn.dataset.sort;
  renderGames();
});

window.addEventListener("DOMContentLoaded", () => {
  const params = parseHash();
  state.icfId = params.id || DEFAULT_ICF_ID;
  state.chesscomUser = params.user || DEFAULT_CHESSCOM_USER;
  state.page = params.page === "games" ? "games" : "profile";
  els.icfInput.value = state.icfId;
  els.chesscomInput.value = state.chesscomUser;
  applyRoute();
  load();
});

function navigate(page) {
  state.page = page === "games" ? "games" : "profile";
  updateHash(state.icfId, state.chesscomUser);
  applyRoute();
  if (state.page === "games") ensureGamesLoaded();
}

function applyRoute() {
  const isGames = state.page === "games";
  for (const el of PROFILE_SECTIONS) if (el) el.classList.toggle("hidden", isGames);
  els.gamesPage.classList.toggle("hidden", !isGames);
  els.navLinks.forEach((a) => a.classList.toggle("active", a.dataset.page === state.page));
  if (isGames) renderGames();
}

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  const out = {};
  for (const part of h.split("&")) {
    const [k, v] = part.split("=");
    if (k && v) out[k] = decodeURIComponent(v);
  }
  return out;
}

function updateHash(icfId, chesscomUser) {
  const parts = [];
  if (state.page && state.page !== "profile") parts.push(`page=${state.page}`);
  if (icfId) parts.push(`id=${icfId}`);
  if (chesscomUser) parts.push(`user=${encodeURIComponent(chesscomUser)}`);
  const hash = "#" + parts.join("&");
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function setStatus(msg, kind) {
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

/* ================= LOAD ================= */

async function load() {
  setStatus("טוען…", "loading");
  state.icf = null;
  state.chesscom = null;
  // Reset view to a neutral state while the network calls are in flight.
  els.icfRow.innerHTML = "";
  els.comRow.innerHTML = "";
  els.ledgerTbody.innerHTML = "";
  els.ledgerEmpty.classList.add("hidden");
  els.chartEmpty.classList.add("hidden");
  els.chartSvg.innerHTML = "";

  const { icfId, chesscomUser } = state;

  const icfP = icfId
    ? loadIcf(icfId)
        .then((r) => { state.icf = r; })
        .catch((e) => { state.icf = { error: e.message }; })
    : Promise.resolve().then(() => { state.icf = null; });

  const ccP = chesscomUser
    ? loadChessCom(chesscomUser)
        .then((r) => { state.chesscom = r; })
        .catch((e) => { state.chesscom = { error: e.message }; })
    : Promise.resolve().then(() => { state.chesscom = null; });

  // Render each block as soon as its source resolves so a slow or failed
  // source never blocks the rest of the dashboard.
  icfP.then(() => { renderHero(); renderIcfBlock(); renderChart(); renderLedger(); });
  ccP.then(() => { renderHero(); renderChessComBlock(); });

  await Promise.all([icfP, ccP]);

  const errors = [];
  if (state.icf?.error) errors.push("איגוד: " + state.icf.error);
  if (state.chesscom?.error) errors.push("chess.com: " + state.chesscom.error);
  setStatus(errors.length ? errors.join(" · ") : "", errors.length ? "error" : "");

  renderSourceLinks();
  els.raw.textContent = JSON.stringify({ icf: state.icf, chesscom: state.chesscom }, null, 2);

  // If the user opened the app on the Games page directly, the initial
  // applyRoute() ran before state.icf existed and nothing triggered the
  // games fetch. Now that ICF data is in, kick it off.
  if (state.page === "games") ensureGamesLoaded();
}

async function loadIcf(id) {
  const targetUrl = `https://www.chess.org.il/Players/Player.aspx?Id=${id}`;
  let html;
  const errors = [];
  for (const makeUrl of PROXIES) {
    const proxyUrl = makeUrl(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const resp = await fetch(proxyUrl, { redirect: "follow", signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.text();
      if (!body || body.length < 500) throw new Error("empty response");
      html = body;
      break;
    } catch (err) {
      const msg = err.name === "AbortError" ? `timeout after ${PROXY_TIMEOUT_MS}ms` : err.message;
      errors.push(`${hostOf(proxyUrl)}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!html) throw new Error("no proxy reachable (" + errors.join("; ") + ")");
  return { ...parsePlayer(html), sourceUrl: targetUrl };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function loadChessCom(username) {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const [profile, stats] = await Promise.all([
    fetchJson(base),
    fetchJson(`${base}/stats`),
  ]);
  const country = profile.country ? await fetchJson(profile.country).catch(() => null) : null;
  return {
    profile,
    stats,
    country,
    sourceUrl: profile.url || `https://www.chess.com/member/${username}`,
  };
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
  return resp.json();
}

/* ================= PARSE (ICF) ================= */

function parsePlayer(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const fields = extractLabelledFields(doc);
  return {
    name: extractName(doc),
    fields,
    ratings: extractRatings(fields),
    tournaments: extractTournaments(doc),
  };
}

function extractLabelledFields(doc) {
  const fields = {};
  // Strategy A — two-cell <tr> (label, value).
  for (const row of doc.querySelectorAll("tr")) {
    const cells = row.querySelectorAll("td, th");
    if (cells.length === 2) {
      const label = cleanText(cells[0].textContent);
      const value = cleanText(cells[1].textContent);
      if (label && value && label.length < 40 && !/^\d+$/.test(label)) {
        if (!fields[label]) fields[label] = value;
      }
    }
  }
  // Strategy B — ASP.NET WebForms <span id="...lblX"> values.
  for (const span of doc.querySelectorAll("span[id]")) {
    const m = (span.id || "").match(/lbl(\w+)$/i);
    if (!m) continue;
    const v = cleanText(span.textContent);
    if (v) fields["_" + m[1]] = v;
  }
  // Strategy C — leaf <li> blocks of the form "label: value". The current
  // chess.org.il profile page renders all profile info this way.
  for (const li of doc.querySelectorAll("li")) {
    if (li.querySelector("li")) continue;
    const text = cleanText(li.textContent);
    if (!text || text.length > 300) continue;
    const m = text.match(/^([^:]{2,40}?)\s*:\s*(.+)$/);
    if (!m) continue;
    const label = m[1].trim();
    const value = m[2].trim();
    if (label && value && !fields[label]) fields[label] = value;
  }
  return fields;
}

const GENERIC_HEADINGS = new Set([
  "פרטי שחקן", "פרטי השחקן", "כרטיס שחקן",
  "Player Details", "Player details", "Player",
]);

// No-op in Hebrew mode — names are displayed as they appear on the source.
function translateName(name) { return name; }

function extractName(doc) {
  const pick = (s) => {
    const t = cleanText(s || "");
    return t && !GENERIC_HEADINGS.has(t) ? t : null;
  };
  // The ICF .player-name div is a *container* (holds the heading, a class
  // paragraph, and the image) — its textContent concatenates ALL children
  // ("פיליפ קרמר דרגה שישית"). Target the heading inside it instead.
  const explicit = doc.querySelector(
    ".player-name h1, .player-name h2, .player-name h3, #MainContent_lblName, [id$='lblName']"
  );
  const fromExplicit = explicit && pick(explicit.textContent);
  if (fromExplicit) return fromExplicit;
  for (const h of doc.querySelectorAll("h1, h2")) {
    const t = pick(h.textContent);
    if (t && t.length >= 2 && t.length <= 80) return t;
  }
  const img = doc.querySelector("img[alt]");
  const fromAlt = img && pick(img.getAttribute("alt"));
  if (fromAlt) return fromAlt;
  const raw = cleanText(doc.querySelector("title")?.textContent || "");
  return raw.split(/\s*[\/|·|\|]\s*/)[0] || raw || "";
}

const LABEL_ALIASES = {
  name: ["שם", "Name", "שם השחקן", "Player", "_Name", "_PlayerName", "_FullName"],
  fideId: ["מספר שחקן פיד\"ה", "FIDE ID", "מספר FIDE", "מס FIDE", "מס' FIDE", "FIDE", "_FIDE", "_FideId", "_FideID"],
  playerId: ["מספר שחקן", "מס שחקן", "מס' שחקן", "ID", "Player ID", "_Id", "_PlayerId"],
  club: ["מועדון", "Club", "אגודה", "_Club"],
  city: ["עיר", "City", "_City"],
  country: ["מדינה", "Country"],
  birth: ["שנת לידה", "תאריך לידה", "לידה", "Birth", "Year of birth", "_BirthYear", "_Birth"],
  title: ["תואר", "Title", "_Title"],
  standard: ["מד כושר ישראלי", "מד כושר", "רגיל", "Standard", "Classical", "_Rating", "_Std", "_Standard"],
  rapid: ["מהיר", "Rapid", "_Rapid"],
  blitz: ["בזק", "Blitz", "_Blitz"],
  nationalRank: ["דירוג בישראל", "דירוג ארצי", "Rank", "National rank"],
  class: ["דרגה", "Class", "Grade"],
  validity: ["תוקף כרטיס שחמטאי", "License valid until"],
  gender: ["מין", "Gender"],
};

function resolveField(fields, key) {
  const aliases = LABEL_ALIASES[key] || [];
  for (const a of aliases) if (fields[a]) return fields[a];
  const lower = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v])
  );
  for (const a of aliases) {
    const v = lower[a.toLowerCase()];
    if (v) return v;
  }
  for (const a of aliases) {
    for (const k of Object.keys(fields)) {
      if (k.toLowerCase().includes(a.toLowerCase())) return fields[k];
    }
  }
  return null;
}

function extractRatings(fields) {
  const pickNumber = (v) => {
    if (!v) return null;
    const m = String(v).match(/-?\d{3,5}/);
    return m ? parseInt(m[0], 10) : null;
  };
  const parseWithProjection = (v) => {
    if (!v) return { current: null, projected: null };
    const s = String(v);
    const current = pickNumber(s);
    const proj = s.match(/(?:צפוי|expected|projected)[^\d-]*(-?\d{3,5})/i);
    return { current, projected: proj ? parseInt(proj[1], 10) : null };
  };
  const std = parseWithProjection(resolveField(fields, "standard"));
  const rawRank = resolveField(fields, "nationalRank");
  const nationalRank = rawRank ? String(rawRank).replace(/\s*\(.*$/, "").trim() : null;
  return {
    standard: std.current,
    standardProjected: std.projected,
    rapid: pickNumber(resolveField(fields, "rapid")),
    blitz: pickNumber(resolveField(fields, "blitz")),
    nationalRank,
    class: resolveField(fields, "class"),
  };
}

// The ICF page is already in Hebrew, so headers and cell values pass
// through untouched. These helpers stay as seams for future localisation.
function translateHeader(h) { return (h || "").trim(); }
function translateCell(v) { return v; }

function extractTournaments(doc) {
  // Leaf tables only — the ICF page nests the tournaments grid inside a
  // PlayerFormView wrapper <table>, and scoring the wrapper would pollute
  // the output with layout cells.
  const tables = [...doc.querySelectorAll("table")].filter(
    (t) => !t.querySelector("table")
  );
  let best = null;
  let bestScore = 0;
  for (const t of tables) {
    const rows = t.querySelectorAll("tr");
    if (rows.length < 2) continue;
    const score = scoreTable(t);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore < 3) return { headers: [], rows: [], structured: [] };

  const trNodes = [...best.querySelectorAll("tr")];
  let headers = [];
  const headerRow =
    best.querySelector("thead tr") ||
    trNodes.find((r) => r.querySelectorAll("th").length > 0) ||
    trNodes[0];
  if (headerRow) {
    headers = [...headerRow.querySelectorAll("th,td")].map((c) => cleanText(c.textContent));
  }

  const col = mapTournamentColumns(headers);
  const dataRows = [];
  const structured = [];
  for (const node of trNodes) {
    if (node === headerRow) continue;
    const cells = [...node.querySelectorAll("td,th")];
    const texts = cells.map((c) => cleanText(c.textContent));
    if (!texts.some((t) => t)) continue;
    dataRows.push(texts);

    // The tournament-name cell holds an <a href="...Id=NNN"> link we can use
    // to deep-link into that tournament's games page on chess.org.il.
    let tournamentId = null;
    if (col.name >= 0 && cells[col.name]) {
      const link = cells[col.name].querySelector('a[href*="Id="]');
      if (link) {
        const m = link.getAttribute("href").match(/Id=(\d+)/);
        if (m) tournamentId = m[1];
      }
    }
    structured.push(buildStructuredRow(col, texts, tournamentId));
  }
  return { headers, rows: dataRows, structured };
}

function scoreTable(t) {
  const rows = [...t.querySelectorAll("tr")];
  if (rows.length < 2) return 0;
  let score = rows.length;
  const sample = rows.slice(0, Math.min(rows.length, 6));
  const cellText = sample
    .map((r) => [...r.querySelectorAll("td,th")].map((c) => c.textContent).join(" "))
    .join(" ");
  if (/\b(19|20)\d{2}\b/.test(cellText)) score += 6;
  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(cellText)) score += 6;
  if (/תאריך|טורניר|תחרות|תוצאה|מקום|שינוי|נקודות|משחקים/.test(cellText)) score += 10;
  if (/tournament|date|result|place|rating|score/i.test(cellText)) score += 6;
  if (rows.length < 3) score -= 4;
  return score;
}

/* Map header labels to column indices. Tolerant of Hebrew + English. */
function mapTournamentColumns(headers) {
  const idx = (patterns) => {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      for (const p of patterns) if (p.test(h)) return i;
    }
    return -1;
  };
  return {
    startDate:   idx([/תאריך התחלה/, /start date/i, /^תאריך$/]),
    updateDate:  idx([/תאריך עדכון|rating update/i]),
    name:        idx([/תחרות|טורניר|tournament/i]),
    games:       idx([/^משחקים$/, /^games$/i]),
    points:      idx([/נקודות|points|score/i]),
    performance: idx([/רמת ביצוע|performance/i]),
    result:      idx([/תוצאה|^result$/i]),
    delta:       idx([/שינוי מד כושר|rating change|^שינוי$/]),
  };
}

function buildStructuredRow(col, r, tournamentId) {
  const deltaRaw = col.delta >= 0 ? r[col.delta] : "";
  const delta = parseDelta(deltaRaw);
  const updateRaw = col.updateDate >= 0 ? r[col.updateDate] : "";
  const pending = /בעדכון הבא|next update/i.test(updateRaw);
  return {
    startDate: col.startDate >= 0 ? r[col.startDate] : "",
    updateDate: updateRaw,
    updateDateParsed: parseICFDate(updateRaw),
    startDateParsed: parseICFDate(col.startDate >= 0 ? r[col.startDate] : ""),
    name: col.name >= 0 ? r[col.name] : "",
    games: col.games >= 0 ? r[col.games] : "",
    points: col.points >= 0 ? r[col.points] : "",
    performance: col.performance >= 0 ? r[col.performance] : "",
    result: col.result >= 0 ? r[col.result] : "",
    deltaRaw,
    delta,
    pending,
    tournamentId,
  };
}

/* Rating change on the ICF page renders as "23.3+" (green) or "5.2-" (red).
 * The trailing sign is the authoritative indicator; the color is cosmetic. */
function parseDelta(s) {
  if (!s) return null;
  const clean = s.replace(/\s+/g, "").trim();
  const m = clean.match(/^([\d.]+)([+\-])?$/) || clean.match(/^([+\-]?[\d.]+)$/);
  if (!m) return null;
  if (m.length === 3 && m[2]) {
    const n = parseFloat(m[1]);
    return m[2] === "-" ? -n : n;
  }
  const n = parseFloat(m[1]);
  return isNaN(n) ? null : n;
}

function parseICFDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = "20" + y;
  const date = new Date(+y, +mo - 1, +d);
  return isNaN(date.getTime()) ? null : date;
}

function cleanText(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/* Reconstruct Classical rating history by walking tournament deltas
 * backward from the current (post-update) rating.
 *
 * The ICF bundles multiple tournaments into a single rating update on the
 * same date, so we first GROUP deltas by update date. Walking per-row
 * would produce stacked points at identical x-values with intermediate
 * rating values that never actually existed on the federation books. */
function buildClassicalHistory(currentRating, structured) {
  if (!Number.isFinite(currentRating) || !structured.length) return [];
  const applied = structured.filter(
    (t) => !t.pending && t.delta != null && t.updateDateParsed
  );
  if (!applied.length) return [];

  // Sum deltas per update date (keyed by ISO day).
  const byDate = new Map();
  for (const t of applied) {
    const key = t.updateDateParsed.toISOString().slice(0, 10);
    const cur = byDate.get(key) || { date: t.updateDateParsed, delta: 0, earliestStart: null };
    cur.delta += t.delta;
    if (t.startDateParsed && (!cur.earliestStart || t.startDateParsed < cur.earliestStart)) {
      cur.earliestStart = t.startDateParsed;
    }
    byDate.set(key, cur);
  }
  // Newest first for the walk.
  const updates = [...byDate.values()].sort((a, b) => b.date - a.date);

  const points = [];
  let after = currentRating;
  for (const u of updates) {
    points.push([u.date, Math.round(after * 10) / 10]);
    after -= u.delta;
  }
  // Anchor with the rating BEFORE the oldest update, dated at the earliest
  // tournament start in that update so the chart has a left-edge point.
  const oldest = updates[updates.length - 1];
  const anchor = oldest.earliestStart && oldest.earliestStart < oldest.date
    ? oldest.earliestStart : null;
  if (anchor) points.push([anchor, Math.round(after * 10) / 10]);

  return points.reverse();
}

/* ================= RENDER ================= */

function renderSourceLinks() {
  els.sourceLinks.innerHTML = "";
  const links = [];
  if (state.icf && !state.icf.error) links.push({ href: state.icf.sourceUrl, label: "צפה ב־chess.org.il" });
  if (state.chesscom && !state.chesscom.error) links.push({ href: state.chesscom.sourceUrl, label: "צפה ב־chess.com" });
  for (const l of links) {
    const a = document.createElement("a");
    a.className = "footer-link";
    a.href = l.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = l.label + " ↗";
    els.sourceLinks.appendChild(a);
  }
}

function renderHero() {
  const icf = (state.icf && !state.icf.error) ? state.icf : null;
  const cc = (state.chesscom && !state.chesscom.error) ? state.chesscom : null;

  els.heroId.textContent = state.icfId ? `#${state.icfId}` : "#—";
  const fideId = icf && resolveField(icf.fields, "fideId");
  els.heroFide.textContent = fideId ? `FIDE ${fideId}` : "FIDE —";

  const displayName = translateName(
    (cc?.profile?.name) ||
    (icf?.name) ||
    (icf && resolveField(icf.fields, "name")) ||
    (cc?.profile?.username ? "@" + cc.profile.username : null) ||
    (state.icfId ? `שחקן איגוד #${state.icfId}` : state.chesscomUser || "—")
  );
  els.heroName.textContent = displayName;

  // Titles
  els.heroTitles.innerHTML = "";
  if (icf && resolveField(icf.fields, "title")) {
    addPill(els.heroTitles, resolveField(icf.fields, "title"), "fide");
  }
  const std = icf?.ratings?.standard;
  if (std != null && std >= 2000) addPill(els.heroTitles, "מומחה");
  else if (std != null && std >= 1800) addPill(els.heroTitles, "דרגה א׳");
  if (cc?.profile?.status === "premium") addPill(els.heroTitles, "chess.com פרימיום");
  if (!els.heroTitles.children.length) addPill(els.heroTitles, "שחקן איגוד");

  // Bio pairs (3 columns × up to 2 rows).
  els.heroBio.innerHTML = "";
  const club = icf && resolveField(icf.fields, "club");
  const country = (cc?.country?.name) || (icf && resolveField(icf.fields, "country"));
  const birth = icf && resolveField(icf.fields, "birth");
  const rank = icf?.ratings?.nationalRank;
  const pairs = [
    ["מועדון", club],
    ["מדינה", country],
    ["שנת לידה", birth, true],
    ["מספר FIDE", fideId, true],
    ["דירוג ארצי", rank ? "#" + rank : null, true],
    ["chess.com", cc?.profile?.username ? "@" + cc.profile.username : null],
  ];
  for (const [k, v, mono] of pairs) {
    if (!v) continue;
    const row = document.createElement("div");
    row.className = "bio-item";
    row.innerHTML = `<div class="bio-label">${esc(k)}</div><div class="bio-value${mono ? " mono" : ""}">${esc(v)}</div>`;
    els.heroBio.appendChild(row);
  }

  // Peak card.
  renderPeakCard(icf);
}

function renderPeakCard(icf) {
  if (!icf) {
    els.peakLabel.textContent = "דירוג איגוד";
    els.peakValue.textContent = "—";
    els.peakSub.textContent = state.icf?.error ? "האיגוד לא זמין" : "לא נטען";
    return;
  }
  const current = icf.ratings.standard;
  const projected = icf.ratings.standardProjected;
  const history = buildClassicalHistory(current, icf.tournaments.structured);
  const historyPeak = history.length ? Math.max(...history.map((p) => p[1])) : null;
  const candidates = [current, projected, historyPeak].filter((n) => n != null);
  const peak = candidates.length ? Math.max(...candidates) : null;

  if (peak == null) {
    els.peakLabel.textContent = "דירוג איגוד";
    els.peakValue.textContent = "—";
    els.peakSub.textContent = "ללא דירוג";
    return;
  }

  if (historyPeak != null && historyPeak >= current && historyPeak >= (projected ?? 0)) {
    const peakPoint = history.find((p) => p[1] === historyPeak);
    els.peakLabel.textContent = "שיא רגיל";
    els.peakValue.textContent = Math.round(historyPeak);
    els.peakSub.textContent = peakPoint
      ? `נרשם ב־${peakPoint[0].toLocaleDateString("he-IL", { month: "short", year: "numeric" })}`
      : "בחשבון משחקי האיגוד";
  } else if (projected != null && projected > current) {
    els.peakLabel.textContent = "דירוג צפוי";
    els.peakValue.textContent = projected;
    const diff = projected - current;
    els.peakSub.textContent = `נוכחי ${current} · ${diff > 0 ? "+" : ""}${diff} בעדכון הבא`;
  } else {
    els.peakLabel.textContent = "מד כושר רגיל";
    els.peakValue.textContent = current;
    els.peakSub.textContent = "כפי שנרשם על ידי האיגוד";
  }
}

function addPill(host, text, cls) {
  const span = document.createElement("span");
  span.className = "title-pill" + (cls ? " " + cls : "");
  span.textContent = text;
  host.appendChild(span);
}

/* -------- ICF ratings block -------- */

function renderIcfBlock() {
  els.icfRow.innerHTML = "";

  if (state.icf?.error) {
    els.icfMeta.textContent = "טעינה נכשלה — " + state.icf.error;
    els.icfMeta.className = "src-meta";
    return;
  }
  if (!state.icf) {
    els.icfMeta.textContent = "chess.org.il · דירוגים רשמיים";
    return;
  }
  const r = state.icf.ratings;
  els.icfMeta.textContent = "chess.org.il · דירוגים רשמיים";

  // Classical (primary, always shown).
  const classicalSub = r.standardProjected != null
    ? `צפוי ${r.standardProjected} (${r.standardProjected - (r.standard ?? 0) >= 0 ? "+" : ""}${r.standardProjected - (r.standard ?? 0)})`
    : "דירוג איגוד ישראלי";
  els.icfRow.appendChild(ratingCell({
    label: "רגיל",
    tag: "ICF",
    value: r.standard,
    sub: classicalSub,
    trend: r.standardProjected != null && r.standard != null ? r.standardProjected - r.standard : null,
    trendUnit: "נק׳ · בעדכון הבא",
    primary: true,
    spark: buildClassicalSpark(state.icf),
  }));

  // National rank.
  els.icfRow.appendChild(ratingCell({
    label: "דירוג ארצי",
    tag: "ISR",
    value: r.nationalRank ? "#" + r.nationalRank : null,
    sub: r.nationalRank ? "מבין שחקנים מדורגים בישראל" : "ללא דירוג",
    missingText: "ללא דירוג",
  }));
}

function buildClassicalSpark(icf) {
  const history = buildClassicalHistory(icf.ratings.standard, icf.tournaments.structured);
  if (history.length < 2) return null;
  return buildSpark(history.map(([d, r]) => [d.getTime(), r]), "var(--tan-deep)", 140, 40);
}

/* -------- chess.com ratings block -------- */

function renderChessComBlock() {
  els.comRow.innerHTML = "";

  if (state.chesscom?.error) {
    els.comMeta.textContent = "טעינה נכשלה — " + state.chesscom.error;
    return;
  }
  if (!state.chesscom) {
    els.comMeta.textContent = "משחק מקוון · דירוג גלוקו";
    return;
  }
  const s = state.chesscom.stats || {};
  const p = state.chesscom.profile || {};
  els.comMeta.textContent = p.username ? `@${p.username} · משחק מקוון` : "משחק מקוון · דירוג גלוקו";

  const modes = [
    { key: "chess_rapid", label: "מהיר", tag: "10|0", primary: true },
    { key: "chess_blitz", label: "בזק", tag: "3|0" },
    { key: "chess_bullet", label: "בולט", tag: "1|0" },
  ];

  for (const m of modes) {
    const obj = s[m.key];
    const current = obj?.last?.rating ?? null;
    const best = obj?.best?.rating ?? null;
    let sub = "ללא משחקים";
    let trend = null;
    if (current != null && best != null) {
      sub = `שיא ${best}`;
      trend = current - best;
    } else if (current != null) {
      sub = "דירוג יחיד";
    }
    els.comRow.appendChild(ratingCell({
      label: m.label,
      tag: m.tag,
      value: current,
      sub,
      trend,
      trendUnit: "נק׳ · מול השיא",
      primary: m.primary,
      missingText: "ללא דירוג",
    }));
  }

  // Games played — sum of W+L+D across all modes.
  const totalGames = ["chess_daily", "chess_rapid", "chess_blitz", "chess_bullet"].reduce((sum, k) => {
    const rec = s[k]?.record;
    if (!rec) return sum;
    return sum + (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0);
  }, 0);
  const joinedYear = p.joined ? new Date(p.joined * 1000).getUTCFullYear() : null;
  els.comRow.appendChild(ratingCell({
    label: "סה״כ משחקים",
    tag: "כל הזמנים",
    value: totalGames || null,
    format: (n) => n.toLocaleString("he-IL"),
    sub: joinedYear ? `מאז ההצטרפות ב־${joinedYear}` : "סך הכל",
    missingText: "ללא משחקים",
  }));
}

function ratingCell({ label, tag, value, sub, trend, trendUnit, primary, spark, format, missingText }) {
  const cell = document.createElement("div");
  cell.className = "rating-cell" + (primary ? " primary" : "");

  const formatted = value == null || value === "" ? null : (format ? format(value) : value);
  const valueHtml = formatted == null
    ? `<div class="rc-value missing">${esc(missingText || "unrated")}</div>`
    : `<div class="rc-value">${esc(formatted)}</div>`;

  let trendHtml = `<div class="rc-trend">${esc(sub || "")}</div>`;
  if (trend != null) {
    const dir = trend > 0 ? "up" : trend < 0 ? "down" : "flat";
    const arrow = trend > 0 ? "▲" : trend < 0 ? "▼" : "·";
    const sign = trend > 0 ? "+" : "";
    trendHtml = `<div class="rc-trend ${dir}"><span class="arrow">${arrow}</span>${sign}${trend} ${esc(trendUnit || "")}</div>`;
  }

  cell.innerHTML = `
    <div class="rc-head">
      <div class="rc-label">${esc(label)}</div>
      <div class="rc-tag">${esc(tag)}</div>
    </div>
    ${valueHtml}
    ${trendHtml}
  `;
  if (spark) cell.appendChild(spark);
  return cell;
}

function buildSpark(series, stroke, w, h) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "rc-spark");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  const xs = series.map((p) => p[0]);
  const ys = series.map((p) => p[1]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xSpan = Math.max(1, xMax - xMin);
  const ySpan = Math.max(1, yMax - yMin);
  const pts = series.map(([x, y]) => [
    ((x - xMin) / xSpan) * w,
    h - ((y - yMin) / ySpan) * (h - 4) - 2,
  ]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L ${w} ${h} L 0 ${h} Z`;

  const fill = document.createElementNS(svgNS, "path");
  fill.setAttribute("d", area);
  fill.setAttribute("fill", stroke);
  fill.setAttribute("opacity", "0.12");
  svg.appendChild(fill);

  const line = document.createElementNS(svgNS, "path");
  line.setAttribute("d", d);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", stroke);
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  const last = pts[pts.length - 1];
  const c = document.createElementNS(svgNS, "circle");
  c.setAttribute("cx", last[0]);
  c.setAttribute("cy", last[1]);
  c.setAttribute("r", "2.5");
  c.setAttribute("fill", stroke);
  svg.appendChild(c);
  return svg;
}

/* -------- Rating trajectory chart -------- */

function renderChart() {
  const svg = els.chartSvg;
  svg.innerHTML = "";

  const icf = (state.icf && !state.icf.error) ? state.icf : null;
  if (!icf) {
    els.chartEmpty.classList.remove("hidden");
    els.chartEmpty.textContent = state.icf?.error
      ? "טעינת נתוני האיגוד נכשלה."
      : "אין מספיק נתוני טורנירים לשחזור היסטוריית הדירוג.";
    return;
  }

  const fullHistory = buildClassicalHistory(icf.ratings.standard, icf.tournaments.structured);
  if (fullHistory.length < 2) {
    els.chartEmpty.classList.remove("hidden");
    els.chartEmpty.textContent = "אין מספיק טורנירים משוחזרים להצגת מסלול.";
    return;
  }
  els.chartEmpty.classList.add("hidden");

  // Apply the toolbar's time window.
  const now = new Date();
  const windowYears = { all: null, "5y": 5, "2y": 2, "1y": 1 }[state.range];
  const history = windowYears
    ? fullHistory.filter(([d]) => (now - d) <= windowYears * 365.25 * 86400000)
    : fullHistory;
  const series = history.length >= 2 ? history : fullHistory;
  const rangeLabel = { "5y": "5 שנים", "2y": "שנתיים", "1y": "שנה" }[state.range];
  els.trajectorySub.textContent = series === fullHistory
    ? `${fullHistory.length} עדכוני דירוג · שוחזרו מהדירוג הנוכחי ${icf.ratings.standard}.`
    : `${series.length} עדכונים ב${rangeLabel === "שנתיים" ? "־" : "־"}${rangeLabel} האחרונות.`;

  const W = 1200, H = 320;
  const pad = { top: 24, right: 70, bottom: 34, left: 56 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const xs = series.map((p) => p[0].getTime());
  const ys = series.map((p) => p[1]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMinRaw = Math.min(...ys), yMaxRaw = Math.max(...ys);
  const yPad = Math.max(15, (yMaxRaw - yMinRaw) * 0.12);
  const yMin = Math.floor((yMinRaw - yPad) / 25) * 25;
  const yMax = Math.ceil((yMaxRaw + yPad) / 25) * 25;
  const sx = (x) => pad.left + ((x - xMin) / Math.max(1, xMax - xMin)) * innerW;
  const sy = (y) => pad.top + innerH - ((y - yMin) / (yMax - yMin)) * innerH;

  const svgNS = "http://www.w3.org/2000/svg";

  // Y gridlines & labels.
  const yStep = yMax - yMin <= 200 ? 25 : yMax - yMin <= 500 ? 50 : 100;
  for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax; y += yStep) {
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", pad.left);
    line.setAttribute("x2", W - pad.right);
    line.setAttribute("y1", sy(y));
    line.setAttribute("y2", sy(y));
    line.setAttribute("stroke", "var(--rule)");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("opacity", "0.6");
    svg.appendChild(line);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", pad.left - 10);
    label.setAttribute("y", sy(y) + 4);
    label.setAttribute("fill", "var(--ink-faint)");
    label.setAttribute("font-family", "var(--mono)");
    label.setAttribute("font-size", "10");
    label.setAttribute("text-anchor", "end");
    label.textContent = y;
    svg.appendChild(label);
  }

  // X ticks — one per year present in the window.
  const years = [...new Set(series.map((p) => p[0].getFullYear()))].sort();
  for (const yr of years) {
    const mid = series.find((p) => p[0].getFullYear() === yr);
    if (!mid) continue;
    const x = sx(mid[0].getTime());
    const tick = document.createElementNS(svgNS, "line");
    tick.setAttribute("x1", x);
    tick.setAttribute("x2", x);
    tick.setAttribute("y1", H - pad.bottom);
    tick.setAttribute("y2", H - pad.bottom + 4);
    tick.setAttribute("stroke", "var(--rule)");
    svg.appendChild(tick);
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", H - pad.bottom + 20);
    label.setAttribute("fill", "var(--ink-dim)");
    label.setAttribute("font-family", "var(--mono)");
    label.setAttribute("font-size", "10");
    label.setAttribute("text-anchor", "middle");
    label.textContent = yr;
    svg.appendChild(label);
  }

  // Baseline.
  const base = document.createElementNS(svgNS, "line");
  base.setAttribute("x1", pad.left);
  base.setAttribute("x2", W - pad.right);
  base.setAttribute("y1", H - pad.bottom);
  base.setAttribute("y2", H - pad.bottom);
  base.setAttribute("stroke", "var(--rule)");
  svg.appendChild(base);

  // Peak annotation.
  const peakPoint = series.reduce((a, b) => (b[1] > a[1] ? b : a), series[0]);
  const peakX = sx(peakPoint[0].getTime());
  const peakY = sy(peakPoint[1]);
  const annLine = document.createElementNS(svgNS, "line");
  annLine.setAttribute("x1", peakX);
  annLine.setAttribute("x2", peakX);
  annLine.setAttribute("y1", peakY);
  annLine.setAttribute("y2", H - pad.bottom);
  annLine.setAttribute("stroke", "var(--tan-deep)");
  annLine.setAttribute("stroke-dasharray", "2 4");
  annLine.setAttribute("opacity", "0.55");
  svg.appendChild(annLine);
  const peakLabel = document.createElementNS(svgNS, "text");
  peakLabel.setAttribute("x", peakX);
  peakLabel.setAttribute("y", peakY - 12);
  peakLabel.setAttribute("fill", "var(--tan-deep)");
  peakLabel.setAttribute("font-family", "var(--serif)");
  peakLabel.setAttribute("font-size", "13");
  peakLabel.setAttribute("font-style", "italic");
  peakLabel.setAttribute("text-anchor", "middle");
  peakLabel.textContent = `שיא · ${Math.round(peakPoint[1])}`;
  svg.appendChild(peakLabel);

  // Series line + area.
  const dPath = series.map(([d, y], i) => (i ? "L" : "M") + sx(d.getTime()).toFixed(1) + " " + sy(y).toFixed(1)).join(" ");
  const areaPath = dPath + ` L ${sx(series[series.length - 1][0].getTime())} ${H - pad.bottom} L ${sx(series[0][0].getTime())} ${H - pad.bottom} Z`;
  const area = document.createElementNS(svgNS, "path");
  area.setAttribute("d", areaPath);
  area.setAttribute("fill", "var(--tan)");
  area.setAttribute("opacity", "0.1");
  svg.appendChild(area);
  const line = document.createElementNS(svgNS, "path");
  line.setAttribute("d", dPath);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--tan-deep)");
  line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  // Dots — emphasize the most recent.
  series.forEach(([d, y], i) => {
    const isLast = i === series.length - 1;
    const c = document.createElementNS(svgNS, "circle");
    c.setAttribute("cx", sx(d.getTime()));
    c.setAttribute("cy", sy(y));
    c.setAttribute("r", isLast ? 4 : 2.5);
    c.setAttribute("fill", isLast ? "var(--bg-warm)" : "var(--tan-deep)");
    c.setAttribute("stroke", "var(--tan-deep)");
    c.setAttribute("stroke-width", isLast ? 2 : 0);
    svg.appendChild(c);
  });

  // End label — the current rating number.
  const last = series[series.length - 1];
  const lab = document.createElementNS(svgNS, "text");
  lab.setAttribute("x", sx(last[0].getTime()) + 10);
  lab.setAttribute("y", sy(last[1]) + 4);
  lab.setAttribute("fill", "var(--tan-deep)");
  lab.setAttribute("font-family", "var(--mono)");
  lab.setAttribute("font-size", "12");
  lab.setAttribute("font-weight", "500");
  lab.textContent = Math.round(last[1]);
  svg.appendChild(lab);
}

/* -------- Tournament ledger -------- */

function renderLedger() {
  const icf = (state.icf && !state.icf.error) ? state.icf : null;
  const structured = icf?.tournaments?.structured || [];
  const q = cleanText(els.search.value).toLowerCase();

  // Reconstruct history once per render so each row can show the rating
  // that was on the books the day after its update was applied.
  const historyMap = icf
    ? new Map(
        buildClassicalHistory(icf.ratings.standard, structured).map(
          ([d, r]) => [d.toISOString().slice(0, 10), r]
        )
      )
    : new Map();

  const headers = [
    { text: "תאריך" },
    { text: "טורניר" },
    { text: "ביצוע", cls: "num" },
    { text: "תוצאה" },
    { text: "Δ דירוג", cls: "num" },
  ];
  els.ledgerThead.innerHTML = "";
  headers.forEach(({ text, cls }) => {
    const th = document.createElement("th");
    th.textContent = text;
    if (cls) th.className = cls;
    els.ledgerThead.appendChild(th);
  });

  els.ledgerTbody.innerHTML = "";

  if (!icf) {
    els.ledgerEmpty.classList.remove("hidden");
    els.ledgerEmpty.textContent = state.icf?.error
      ? "טעינת הטורנירים נכשלה."
      : "ממתין ל־chess.org.il…";
    els.ledgerCount.textContent = "—";
    return;
  }

  const filtered = structured.filter((t) => {
    if (!q) return true;
    return [t.name, t.result, t.startDate, t.updateDate, t.performance].some(
      (s) => (s || "").toLowerCase().includes(q)
    );
  });

  els.ledgerCount.textContent = structured.length
    ? `${structured.length} אירועים רשומים, מהחדש לישן${q ? ` · ${filtered.length} תואמים` : ""}.`
    : "לא נרשמו טורנירים.";

  if (!filtered.length) {
    els.ledgerEmpty.classList.remove("hidden");
    els.ledgerEmpty.textContent = q ? "לא נמצאו טורנירים תואמים לחיפוש." : "לא נרשמו טורנירים.";
    return;
  }
  els.ledgerEmpty.classList.add("hidden");

  for (const t of filtered) {
    const tr = document.createElement("tr");

    // Date — formatted in Hebrew locale (e.g. "2025 · ינו׳ 03").
    const parsed = t.startDateParsed || t.updateDateParsed;
    const dateHtml = parsed
      ? `<span class="yr">${parsed.getFullYear()}</span> · ${parsed.toLocaleString("he-IL", { month: "short" })} ${String(parsed.getDate()).padStart(2, "0")}`
      : esc(t.startDate || t.updateDate || "—");

    // Tournament cell — name + meta line with score %.
    const metaBits = [];
    const parsedResult = parseResult(t.result);
    const pointsNum = t.points ? parseFloat(t.points) : null;
    const gamesNum = t.games ? parseInt(t.games, 10) : null;
    if (gamesNum) metaBits.push(`${gamesNum} משחקים`);
    if (pointsNum != null && gamesNum) {
      const pct = Math.round((pointsNum / gamesNum) * 100);
      metaBits.push(`${pointsNum} / ${gamesNum} נק׳ · ${pct}%`);
    } else if (pointsNum != null) {
      metaBits.push(`${pointsNum} נק׳`);
    }
    if (t.updateDate && !t.pending) metaBits.push(t.updateDate);
    else if (t.pending) metaBits.push("יחול בעדכון הבא");

    // Performance — separate column, right-aligned mono.
    const perfHtml = t.performance
      ? `<span class="lgr-perf" dir="ltr">${esc(t.performance)}</span>`
      : `<span class="lgr-perf muted">—</span>`;

    // W/L/D chips.
    let resultHtml;
    if (parsedResult) {
      resultHtml = `
        <div class="lgr-wld" dir="ltr">
          <span class="wld win" title="ניצחונות">${parsedResult.wins}W</span>
          <span class="wld draw" title="תיקו">${parsedResult.draws}D</span>
          <span class="wld loss" title="הפסדים">${parsedResult.losses}L</span>
        </div>`;
    } else {
      const isPodium = /^1\s*\/|^1\s*$|1st|ניצחון|מקום 1/i.test(t.result || "");
      resultHtml = t.result
        ? `<span class="lgr-place${isPodium ? " podium" : ""}" dir="ltr">${esc(t.result)}</span>`
        : `<span class="lgr-place muted">—</span>`;
    }

    // Δ pill + "→ rating after update" hint.
    let deltaHtml;
    if (t.pending) {
      deltaHtml = `<span class="lgr-delta pending">ממתין</span>`;
    } else if (t.delta == null) {
      deltaHtml = `<span class="lgr-delta flat">·</span>`;
    } else {
      const cls = t.delta > 0 ? "up" : t.delta < 0 ? "down" : "flat";
      const sign = t.delta > 0 ? "+" : "";
      deltaHtml = `<span class="lgr-delta ${cls}" dir="ltr">${sign}${t.delta.toFixed(1)}</span>`;
    }
    const afterKey = t.updateDateParsed ? t.updateDateParsed.toISOString().slice(0, 10) : null;
    const afterRating = afterKey ? historyMap.get(afterKey) : null;
    const afterHtml = afterRating != null
      ? `<div class="lgr-after" dir="ltr">→ ${Math.round(afterRating)}</div>`
      : "";

    tr.innerHTML = `
      <td><div class="lgr-date" dir="ltr">${dateHtml}</div></td>
      <td>
        <div class="lgr-name">${esc(t.name || "—")}</div>
        ${metaBits.length ? `<div class="lgr-meta">${esc(metaBits.join(" · "))}</div>` : ""}
      </td>
      <td class="num">${perfHtml}</td>
      <td>${resultHtml}</td>
      <td class="num">${deltaHtml}${afterHtml}</td>
    `;
    els.ledgerTbody.appendChild(tr);
  }
}

/* Parse "+W-L=D" tournament result strings into their component counts. */
function parseResult(s) {
  if (!s) return null;
  const t = s.replace(/\s+/g, "");
  const m = t.match(/^\+?(\d+)-(\d+)=(\d+)$/) || t.match(/^\+?(\d+)-(\d+)$/);
  if (!m) return null;
  return {
    wins: parseInt(m[1], 10),
    losses: parseInt(m[2], 10),
    draws: parseInt(m[3] || "0", 10),
  };
}

/* ================= GAMES PAGE ================= */

async function ensureGamesLoaded() {
  // Already loaded or still loading for the current ICF id — just render.
  if (state.games?.byIcfId === state.icfId && (state.games.aggregated || state.games.loading)) {
    renderGames();
    return;
  }
  const icf = state.icf && !state.icf.error ? state.icf : null;
  if (!icf) {
    state.games = { byIcfId: state.icfId, error: state.icf?.error || "האיגוד לא נטען עדיין" };
    renderGames();
    return;
  }
  const withIds = (icf.tournaments.structured || []).filter((t) => t.tournamentId);
  if (!withIds.length) {
    state.games = { byIcfId: state.icfId, error: "אין טורנירים עם מזהה לשחזור משחקים" };
    renderGames();
    return;
  }

  state.games = { byIcfId: state.icfId, loading: true, total: withIds.length, done: 0 };
  renderGames();

  // Fetch all tournament detail pages in parallel. The codetabs proxy has
  // been reliable; if we see rate-limits later we can switch to a limited
  // concurrency queue.
  const results = await Promise.all(
    withIds.map((t) =>
      fetchTournamentGames(t)
        .then((r) => {
          state.games.done++;
          renderGames();
          return r;
        })
        .catch((e) => {
          state.games.done++;
          renderGames();
          return { tournamentId: t.tournamentId, tournamentName: t.name, error: e.message };
        })
    )
  );

  const allGames = [];
  const failures = [];
  for (const r of results) {
    if (r.error) { failures.push(r); continue; }
    for (const g of r.games) {
      allGames.push({
        ...g,
        tournamentId: r.tournamentId,
        tournamentName: r.tournamentName,
        tournamentDate: r.tournamentDate,
      });
    }
  }

  state.games = {
    byIcfId: state.icfId,
    data: allGames,
    aggregated: aggregateByOpponent(allGames),
    failures,
  };
  renderGames();
}

async function fetchTournamentGames(tournament) {
  const targetUrl = `https://www.chess.org.il/Tournaments/PlayerInTournament.aspx?Id=${tournament.tournamentId}`;
  const html = await fetchViaProxy(targetUrl);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return {
    tournamentId: tournament.tournamentId,
    tournamentName: tournament.name,
    tournamentDate: tournament.startDateParsed,
    games: parseGamesTable(doc),
  };
}

async function fetchViaProxy(targetUrl) {
  const errors = [];
  for (const makeUrl of PROXIES) {
    const proxyUrl = makeUrl(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const resp = await fetch(proxyUrl, { redirect: "follow", signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.text();
      if (!body || body.length < 500) throw new Error("empty response");
      return body;
    } catch (err) {
      const msg = err.name === "AbortError" ? `timeout ${PROXY_TIMEOUT_MS}ms` : err.message;
      errors.push(`${hostOf(proxyUrl)}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join("; "));
}

/* Parse the ICF tournament detail page's GamesGridView table. */
function parseGamesTable(doc) {
  const table =
    doc.querySelector('[id*="GamesGridView"]') ||
    [...doc.querySelectorAll("table")].find((t) => /סיבוב|round/i.test(t.textContent));
  if (!table) return [];
  const rows = [...table.querySelectorAll("tbody tr, tr")].filter(
    (r) => r.querySelectorAll("td").length >= 4
  );
  const games = [];
  for (const row of rows) {
    const cells = [...row.querySelectorAll("td")];
    if (cells.length < 4) continue;
    const round = cleanText(cells[0].textContent);
    const colorImg = cells[1].querySelector("img");
    const color = colorImg
      ? colorImg.getAttribute("title") || colorImg.getAttribute("alt") || ""
      : "";
    const resultRaw = cleanText(cells[2].textContent);
    const opponentLink = cells[3].querySelector("a");
    const rawOpp = cleanText(opponentLink ? opponentLink.textContent : cells[3].textContent);
    // Opponent cells look like "איתמר סניור (8)" — the trailing parenthetical
    // is the opponent's seeding number inside this tournament; strip it.
    const opponentName = rawOpp.replace(/\s*\(\d+\)\s*$/, "");
    const opponentRating = cells[4] ? parseInt(cleanText(cells[4].textContent), 10) || null : null;
    games.push({
      round: parseInt(round, 10) || round,
      color,
      result: classifyResult(resultRaw),
      resultRaw,
      opponentName,
      opponentRating,
    });
  }
  return games;
}

function classifyResult(s) {
  const t = (s || "").trim();
  if (t === "1") return "win";
  if (t === "0") return "loss";
  if (t === "½" || t === "0.5" || t === "1/2") return "draw";
  return "other";
}

function aggregateByOpponent(games) {
  const map = new Map();
  for (const g of games) {
    if (!g.opponentName) continue;
    // Skip rounds that haven't been played yet (empty result cells in the
    // GamesGridView of an in-progress tournament).
    if (g.result === "other") continue;
    let rec = map.get(g.opponentName);
    if (!rec) {
      rec = { name: g.opponentName, games: [], wins: 0, losses: 0, draws: 0, ratingSum: 0, ratingCount: 0, lastPlayed: null };
      map.set(g.opponentName, rec);
    }
    rec.games.push(g);
    if (g.result === "win") rec.wins++;
    else if (g.result === "loss") rec.losses++;
    else if (g.result === "draw") rec.draws++;
    if (g.opponentRating) { rec.ratingSum += g.opponentRating; rec.ratingCount++; }
    if (g.tournamentDate && (!rec.lastPlayed || g.tournamentDate > rec.lastPlayed)) {
      rec.lastPlayed = g.tournamentDate;
    }
  }
  for (const rec of map.values()) {
    rec.total = rec.games.length;
    rec.avgRating = rec.ratingCount ? Math.round(rec.ratingSum / rec.ratingCount) : null;
    rec.score = rec.wins + rec.draws * 0.5;
    // Sort each opponent's games newest-first for the drill-down.
    rec.games.sort((a, b) => {
      const da = a.tournamentDate ? a.tournamentDate.getTime() : 0;
      const db = b.tournamentDate ? b.tournamentDate.getTime() : 0;
      return db - da;
    });
  }
  // Primary sort: total games desc; tiebreaker: score rate desc, then name.
  return [...map.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return b.score / b.total - a.score / a.total;
  });
}

function renderGames() {
  if (state.page !== "games") return;

  const container = els.gamesBody;
  container.innerHTML = "";

  if (!state.games) {
    els.gamesSub.textContent = "ממתין ל־chess.org.il…";
    container.appendChild(gamesMessage("טוען נתוני פרופיל…"));
    renderGamesSummary();
    return;
  }
  if (state.games.error) {
    els.gamesSub.textContent = "לא ניתן היה לטעון משחקים.";
    container.appendChild(gamesMessage(state.games.error, "error"));
    renderGamesSummary();
    return;
  }
  if (state.games.loading) {
    els.gamesSub.textContent = `מוריד ${state.games.done} מתוך ${state.games.total} טורנירים…`;
    container.appendChild(gamesMessage(`טוען פרטי טורנירים · ${state.games.done}/${state.games.total}`));
    renderGamesSummary();
    return;
  }

  // Year filter + sort highlight: keep button states in sync on every render.
  renderYearFilter();
  [...els.gamesSort.querySelectorAll("button[data-sort]")].forEach((b) =>
    b.classList.toggle("active", b.dataset.sort === state.gamesSort)
  );
  const allGames = (state.games.data || []).filter((g) => g.result !== "other");
  const yearFiltered = state.gamesYear === "all"
    ? allGames
    : allGames.filter((g) => g.tournamentDate && g.tournamentDate.getFullYear() === +state.gamesYear);
  const aggregated = sortAggregated(aggregateByOpponent(yearFiltered), state.gamesSort);

  const q = cleanText(els.gamesSearch.value).toLowerCase();
  const filtered = aggregated
    .map((rec) => {
      if (!q) return { rec, games: rec.games };
      if (rec.name.toLowerCase().includes(q)) return { rec, games: rec.games };
      const matchingGames = rec.games.filter((g) =>
        (g.tournamentName || "").toLowerCase().includes(q)
      );
      return matchingGames.length ? { rec, games: matchingGames } : null;
    })
    .filter(Boolean);

  const yearLabel = state.gamesYear === "all" ? "" : ` · ${state.gamesYear}`;
  els.gamesSub.textContent =
    `${aggregated.length} יריבים · ${yearFiltered.length} משחקים${yearLabel}` +
    (q ? ` · ${filtered.length} תואמים` : "") +
    (state.games.failures?.length ? ` · ${state.games.failures.length} טורנירים לא נטענו` : "");

  renderGamesSummary(yearFiltered, aggregated.length);

  if (!filtered.length) {
    container.appendChild(gamesMessage(
      state.gamesYear === "all" ? "לא נמצאו תוצאות." : `אין משחקים בשנת ${state.gamesYear}.`
    ));
    return;
  }

  const table = document.createElement("table");
  table.className = "ledger-table games-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>יריב</th>
        <th class="num">משחקים</th>
        <th>מאזן</th>
        <th class="num">ניקוד</th>
        <th class="num">ממוצע דירוג</th>
        <th class="num">משחק אחרון</th>
      </tr>
    </thead>
    <tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  for (const { rec, games } of filtered) {
    const isOpen = state.gamesExpanded.has(rec.name);
    const row = document.createElement("tr");
    row.className = "games-row" + (isOpen ? " open" : "");
    row.tabIndex = 0;
    row.innerHTML = `
      <td>
        <div class="lgr-name">${esc(rec.name)}</div>
        <div class="lgr-meta">${esc(ratioText(rec))}</div>
      </td>
      <td class="num"><span class="games-count" dir="ltr">${rec.total}</span></td>
      <td>
        <div class="lgr-wld" dir="ltr">
          <span class="wld win">${rec.wins}W</span>
          <span class="wld draw">${rec.draws}D</span>
          <span class="wld loss">${rec.losses}L</span>
        </div>
      </td>
      <td class="num" dir="ltr">${formatScore(rec.score)} / ${rec.total}</td>
      <td class="num" dir="ltr">${rec.avgRating ?? "—"}</td>
      <td class="num" dir="ltr">${rec.lastPlayed ? rec.lastPlayed.toLocaleDateString("he-IL", { year: "numeric", month: "short" }) : "—"}</td>
    `;
    row.addEventListener("click", () => {
      if (state.gamesExpanded.has(rec.name)) state.gamesExpanded.delete(rec.name);
      else state.gamesExpanded.add(rec.name);
      renderGames();
    });
    tbody.appendChild(row);

    if (isOpen) {
      const detail = document.createElement("tr");
      detail.className = "games-detail";
      const td = document.createElement("td");
      td.colSpan = 6;
      td.appendChild(buildGameDetailTable(games));
      detail.appendChild(td);
      tbody.appendChild(detail);
    }
  }
  container.appendChild(table);
}

function renderGamesSummary(gamesSlice, uniqueOppsCount) {
  const summary = els.gamesSummary;
  summary.innerHTML = "";
  if (!state.games || state.games.loading || state.games.error) return;
  // Called with the current filter's slice when available; falls back to
  // the full played-game set for loading / unfiltered callers.
  const games = gamesSlice || (state.games.data || []).filter((g) => g.result !== "other");
  const totals = games.reduce(
    (acc, g) => {
      if (g.result === "win") acc.wins++;
      else if (g.result === "loss") acc.losses++;
      else if (g.result === "draw") acc.draws++;
      return acc;
    },
    { wins: 0, losses: 0, draws: 0 }
  );
  const total = games.length;
  const score = totals.wins + totals.draws * 0.5;
  const rate = total ? Math.round((score / total) * 100) : 0;
  const uniqueOpps = uniqueOppsCount ?? state.games.aggregated?.length ?? 0;

  const tiles = [
    { label: "סך משחקים", value: total },
    { label: "יריבים ייחודיים", value: uniqueOpps },
    { label: "ניקוד", value: `${formatScore(score)} / ${total}` },
    { label: "אחוז ניצחון", value: `${rate}%` },
    { label: "ניצחונות", value: totals.wins, cls: "win" },
    { label: "תיקו", value: totals.draws, cls: "draw" },
    { label: "הפסדים", value: totals.losses, cls: "loss" },
  ];
  for (const t of tiles) {
    const tile = document.createElement("div");
    tile.className = "games-tile" + (t.cls ? " " + t.cls : "");
    tile.innerHTML = `<div class="games-tile-label">${esc(t.label)}</div>
      <div class="games-tile-value" dir="ltr">${esc(String(t.value))}</div>`;
    summary.appendChild(tile);
  }
}

function renderYearFilter() {
  const bar = els.gamesYearFilter;
  if (!state.games?.data) { bar.innerHTML = ""; return; }
  const years = [...new Set(
    state.games.data
      .filter((g) => g.result !== "other" && g.tournamentDate)
      .map((g) => g.tournamentDate.getFullYear())
  )].sort((a, b) => b - a);
  // Make sure the active year is still valid (e.g. user changed player ID).
  if (state.gamesYear !== "all" && !years.includes(+state.gamesYear)) {
    state.gamesYear = "all";
  }
  bar.innerHTML = "";
  const addBtn = (value, label) => {
    const btn = document.createElement("button");
    btn.dataset.year = value;
    btn.textContent = label;
    if (String(value) === String(state.gamesYear)) btn.classList.add("active");
    bar.appendChild(btn);
  };
  addBtn("all", "הכל");
  for (const y of years) addBtn(String(y), String(y));
}

function sortAggregated(list, mode) {
  const arr = list.slice();
  if (mode === "played") {
    arr.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (b.lastPlayed?.getTime() || 0) - (a.lastPlayed?.getTime() || 0);
    });
  } else if (mode === "rating") {
    arr.sort((a, b) => {
      const ar = a.avgRating ?? -1;
      const br = b.avgRating ?? -1;
      if (br !== ar) return br - ar;
      return (b.lastPlayed?.getTime() || 0) - (a.lastPlayed?.getTime() || 0);
    });
  } else {
    // "recent" — default
    arr.sort((a, b) => {
      const at = a.lastPlayed?.getTime() || 0;
      const bt = b.lastPlayed?.getTime() || 0;
      if (bt !== at) return bt - at;
      return b.total - a.total;
    });
  }
  return arr;
}

function gamesMessage(text, cls) {
  const p = document.createElement("p");
  p.className = "games-message" + (cls ? " " + cls : "");
  p.textContent = text;
  return p;
}

function ratioText(rec) {
  if (!rec.total) return "";
  const rate = Math.round(((rec.wins + rec.draws * 0.5) / rec.total) * 100);
  return `${rate}% ניצחון`;
}

function formatScore(n) {
  return n.toLocaleString("he-IL", { maximumFractionDigits: 1 });
}

function buildGameDetailTable(games) {
  const wrap = document.createElement("div");
  wrap.className = "games-inner";
  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>טורניר</th>
        <th class="num">סיבוב</th>
        <th>צבע</th>
        <th>תוצאה</th>
        <th class="num">דירוג יריב</th>
      </tr>
    </thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  for (const g of games) {
    const cls = g.result === "win" ? "up" : g.result === "loss" ? "down" : g.result === "draw" ? "flat" : "flat";
    const resultLabel =
      g.result === "win" ? "ניצחון" :
      g.result === "loss" ? "הפסד" :
      g.result === "draw" ? "תיקו" :
      g.resultRaw || "—";
    const dateSuffix = g.tournamentDate
      ? `<span class="games-tdate" dir="ltr">${g.tournamentDate.toLocaleDateString("he-IL", { year: "numeric", month: "short" })}</span>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <a class="games-tname" href="https://www.chess.org.il/Tournaments/PlayerInTournament.aspx?Id=${esc(g.tournamentId)}" target="_blank" rel="noopener">${esc(g.tournamentName || "—")} ↗</a>
        ${dateSuffix}
      </td>
      <td class="num" dir="ltr">${esc(String(g.round))}</td>
      <td><span class="games-color ${g.color === "לבן" ? "white" : "black"}">${esc(g.color || "—")}</span></td>
      <td><span class="lgr-delta ${cls}">${esc(resultLabel)}</span></td>
      <td class="num" dir="ltr">${g.opponentRating ?? "—"}</td>
    `;
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}
