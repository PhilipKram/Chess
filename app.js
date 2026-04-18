/* Chess Stats Dashboard
 * Loads a player's profile from two sources in parallel:
 *   - chess.org.il (Israeli Chess Federation) — HTML scraped via a public
 *     CORS proxy and parsed with DOMParser.
 *   - chess.com    — JSON from the public /pub/player API (CORS-enabled, no
 *     proxy needed).
 */

const DEFAULT_ICF_ID = "207079";
const DEFAULT_CHESSCOM_USER = "silverbullet20000";

// Public CORS proxies for chess.org.il, tried in order.
// codetabs is currently the most reliable; the others are kept as fallbacks
// because public proxies come and go.
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
  card: document.getElementById("player-card"),
  name: document.getElementById("player-name"),
  meta: document.getElementById("player-meta"),
  sources: document.getElementById("player-sources"),
  avatarImg: document.getElementById("player-avatar"),
  avatarPiece: document.getElementById("player-piece"),
  icfStatus: document.getElementById("icf-status"),
  icfGrid: document.getElementById("icf-rating-grid"),
  chesscomStatus: document.getElementById("chesscom-status"),
  chesscomGrid: document.getElementById("chesscom-rating-grid"),
  chesscomRecords: document.getElementById("chesscom-records"),
  theadRow: document.getElementById("tournaments-thead-row"),
  tbody: document.getElementById("tournaments-tbody"),
  empty: document.getElementById("tournaments-empty"),
  search: document.getElementById("tournament-search"),
  raw: document.getElementById("raw-json"),
};

let lastTournaments = [];
let lastTHeaders = [];

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const icfId = (els.icfInput.value || "").trim();
  const chesscomUser = (els.chesscomInput.value || "").trim();
  if (icfId && !/^\d+$/.test(icfId)) {
    setStatus("ICF ID must be numeric.", "error");
    return;
  }
  updateHash(icfId, chesscomUser);
  load(icfId, chesscomUser);
});

els.search.addEventListener("input", () => renderTournaments(lastTournaments, lastTHeaders));

window.addEventListener("DOMContentLoaded", () => {
  const params = parseHash();
  const icfId = params.id || DEFAULT_ICF_ID;
  const chesscomUser = params.user || DEFAULT_CHESSCOM_USER;
  els.icfInput.value = icfId;
  els.chesscomInput.value = chesscomUser;
  load(icfId, chesscomUser);
});

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
  if (icfId) parts.push(`id=${icfId}`);
  if (chesscomUser) parts.push(`user=${encodeURIComponent(chesscomUser)}`);
  const hash = "#" + parts.join("&");
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function setStatus(msg, kind) {
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setSectionStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.className = "section-status" + (kind ? " " + kind : "");
}

async function load(icfId, chesscomUser) {
  setStatus("Loading…", "loading");
  els.card.classList.add("hidden");
  els.icfGrid.innerHTML = "";
  els.chesscomGrid.innerHTML = "";
  els.chesscomRecords.innerHTML = "";
  els.tbody.innerHTML = "";
  els.empty.classList.add("hidden");
  setSectionStatus(els.icfStatus, icfId ? "Loading…" : "No ICF ID entered.");
  setSectionStatus(els.chesscomStatus, chesscomUser ? "Loading…" : "No chess.com username entered.");

  const state = { icfId, chesscomUser, icf: null, chesscom: null };
  const updateCard = () => renderPlayerCard(state);

  const icfP = icfId
    ? loadIcf(icfId)
        .then((r) => { state.icf = r; renderIcf(r); updateCard(); })
        .catch((e) => { state.icf = { error: e.message }; renderIcf(state.icf); updateCard(); })
    : Promise.resolve().then(() => { renderIcf(null); updateCard(); });

  const ccP = chesscomUser
    ? loadChessCom(chesscomUser)
        .then((r) => { state.chesscom = r; renderChessCom(r); updateCard(); })
        .catch((e) => { state.chesscom = { error: e.message }; renderChessCom(state.chesscom); updateCard(); })
    : Promise.resolve().then(() => { renderChessCom(null); updateCard(); });

  await Promise.all([icfP, ccP]);

  const errors = [];
  if (state.icf?.error) errors.push("ICF: " + state.icf.error);
  if (state.chesscom?.error) errors.push("Chess.com: " + state.chesscom.error);
  setStatus(errors.length ? errors.join(" · ") : "", errors.length ? "error" : "");

  els.raw.textContent = JSON.stringify(
    { icf: state.icf, chesscom: state.chesscom },
    null,
    2
  );
}

/* ---------- chess.org.il (ICF) ---------- */

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

function parsePlayer(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return {
    name: extractName(doc),
    fields: extractLabelledFields(doc),
    ratings: extractRatings(doc),
    tournaments: extractTournaments(doc),
  };
}

// Generic section headers used on chess.org.il that must NOT be mistaken
// for the player's name. The page renders "Player Details" / "Player Card"
// as an <h2> before the <h2> that actually holds the name.
const GENERIC_HEADINGS = new Set([
  "פרטי שחקן", "פרטי השחקן", "כרטיס שחקן",
  "Player Details", "Player details", "Player",
]);

// Hebrew → English name overrides. Hebrew is written without vowels, so
// generic letter-by-letter transliteration produces unreadable output
// ("פיליפ קרמר" → "PYLYP KRMR"); named entries beat a transliterator.
// Add more entries as needed.
const NAME_OVERRIDES = {
  "פיליפ קרמר": "Philip Kramer",
};

function translateName(name) {
  if (!name) return name;
  return NAME_OVERRIDES[name.trim()] || name;
}

function extractName(doc) {
  const pick = (s) => {
    const t = cleanText(s || "");
    return t && !GENERIC_HEADINGS.has(t) ? t : null;
  };
  // Prefer an explicit name label/class if present.
  const explicit = doc.querySelector(".player-name, #MainContent_lblName, [id$='lblName']");
  const fromExplicit = explicit && pick(explicit.textContent);
  if (fromExplicit) return fromExplicit;
  // Then pick the first <h1>/<h2> that isn't a generic section title.
  for (const h of doc.querySelectorAll("h1, h2")) {
    const t = pick(h.textContent);
    if (t && t.length >= 2 && t.length <= 80) return t;
  }
  // Fall back to the player-image alt attribute, which chess.org.il sets
  // to the player's name.
  const img = doc.querySelector("img[alt]");
  const fromAlt = img && pick(img.getAttribute("alt"));
  if (fromAlt) return fromAlt;
  // Last resort: <title>, stripped of the site suffix.
  const raw = cleanText(doc.querySelector("title")?.textContent || "");
  return raw.split(/\s*[\/|·|\|]\s*/)[0] || raw || "";
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
  // Strategy C — leaf <li> blocks of the form "label: value".
  // The current chess.org.il profile page renders everything this way.
  for (const li of doc.querySelectorAll("li")) {
    if (li.querySelector("li")) continue; // skip nav containers
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
  // דירוג בישראל is the national ranking position (e.g. #3096 in Israel).
  // Keep this list clean of generic aliases like "דירוג" — that substring
  // also appears inside rating labels and would mis-match.
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

function extractRatings(doc) {
  const fields = extractLabelledFields(doc);
  const pickNumber = (v) => {
    if (!v) return null;
    const m = String(v).match(/-?\d{3,5}/);
    return m ? parseInt(m[0], 10) : null;
  };
  // The Israeli rating field looks like "1445 (צפוי: 1467)" — first number
  // is the current rating, any later number following "צפוי"/"expected" is
  // the projected rating that will take effect at the next rating period.
  const parseWithProjection = (v) => {
    if (!v) return { current: null, projected: null };
    const s = String(v);
    const current = pickNumber(s);
    const proj = s.match(/(?:צפוי|expected|projected)[^\d-]*(-?\d{3,5})/i);
    return { current, projected: proj ? parseInt(proj[1], 10) : null };
  };
  const std = parseWithProjection(resolveField(fields, "standard"));
  // Strip parenthetical context off the national rank so it renders cleanly.
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

function extractTournaments(doc) {
  // Only consider *leaf* tables — the ICF page nests the tournaments table
  // inside a PlayerFormView wrapper <table>; scoring the wrapper would
  // inherit all the inner rows and win, then pollute the output with the
  // wrapper's layout cells.
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
  if (!best || bestScore < 3) return { headers: [], rows: [] };

  const rows = [...best.querySelectorAll("tr")];
  let headers = [];
  const headerRow =
    best.querySelector("thead tr") ||
    rows.find((r) => r.querySelectorAll("th").length > 0) ||
    rows[0];
  if (headerRow) {
    headers = [...headerRow.querySelectorAll("th,td")].map((c) =>
      cleanText(c.textContent)
    );
  }
  const dataRows = rows
    .filter((r) => r !== headerRow)
    .map((r) => [...r.querySelectorAll("td,th")].map((c) => cleanText(c.textContent)))
    .filter((r) => r.some((c) => c));

  return { headers, rows: dataRows };
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

/* Hebrew → English translation for the chess.org.il tournament table.
 * Headers are what the site uses today (2026); the extra entries are
 * fallbacks for older/alternative layouts. */
const HEADER_TRANSLATIONS = {
  "תאריך התחלה": "Start date",
  "תאריך עדכון מד כושר": "Rating update",
  "תחרות": "Tournament",
  "משחקים": "Games",
  "נקודות": "Points",
  "רמת ביצוע": "Performance",
  "תוצאה": "Result",
  "שינוי מד כושר": "Rating change",
  // Fallbacks for layouts we've seen before.
  "תאריך": "Date",
  "טורניר": "Tournament",
  "שם טורניר": "Tournament",
  "שם הטורניר": "Tournament",
  "מקום": "Place",
  "שינוי": "Change",
  "ניקוד": "Score",
  "סבבים": "Rounds",
  "יריב": "Opponent",
  "שם יריב": "Opponent",
  "דירוג": "Rating",
  "צבע": "Color",
  "שחור": "Black",
  "לבן": "White",
  "הפתעה": "Upset",
  "מד כושר": "Rating",
};

/* Translations for full-cell Hebrew phrases seen in tournament rows.
 * Keep this narrow — player-facing strings (club names, tournament titles)
 * are free-form Hebrew and should pass through untouched. */
const CELL_TRANSLATIONS = {
  "בעדכון הבא": "next update",
};

function translateHeader(h) {
  if (!h) return h;
  const trimmed = h.trim();
  return HEADER_TRANSLATIONS[trimmed] || trimmed;
}

function translateCell(v) {
  if (!v) return v;
  const trimmed = v.trim();
  if (CELL_TRANSLATIONS[trimmed]) return CELL_TRANSLATIONS[trimmed];
  // "עדכון 01/03/2026" → "updated 01/03/2026"
  const m = trimmed.match(/^עדכון\s+(.+)$/);
  if (m) return `updated ${m[1]}`;
  return v;
}

function cleanText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- chess.com ---------- */

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

/* ---------- rendering ---------- */

function renderPlayerCard({ icfId, chesscomUser, icf, chesscom }) {
  const icfData = icf && !icf.error ? icf : null;
  const ccData = chesscom && !chesscom.error ? chesscom : null;

  const displayName = translateName(
    (ccData?.profile?.name) ||
    (icfData?.name) ||
    (icfData && resolveField(icfData.fields, "name")) ||
    (ccData?.profile?.username) ||
    (icfId ? `ICF Player #${icfId}` : chesscomUser || "—")
  );

  els.name.textContent = displayName;

  // Avatar: chess.com photo if present, otherwise the ♚ glyph.
  if (ccData?.profile?.avatar) {
    els.avatarImg.src = ccData.profile.avatar;
    els.avatarImg.alt = displayName;
    els.avatarImg.classList.remove("hidden");
    els.avatarPiece.classList.add("hidden");
  } else {
    els.avatarImg.removeAttribute("src");
    els.avatarImg.classList.add("hidden");
    els.avatarPiece.classList.remove("hidden");
  }

  els.meta.innerHTML = "";
  const metaPairs = [];
  if (icfId) metaPairs.push(["ICF ID", icfId]);
  if (icfData) {
    const fideId = resolveField(icfData.fields, "fideId");
    const club = resolveField(icfData.fields, "club");
    const city = resolveField(icfData.fields, "city");
    const title = resolveField(icfData.fields, "title");
    const birth = resolveField(icfData.fields, "birth");
    const rank = icfData.ratings?.nationalRank;
    const klass = icfData.ratings?.class;
    if (fideId) metaPairs.push(["FIDE ID", fideId]);
    if (club) metaPairs.push(["Club", club]);
    if (city) metaPairs.push(["City", city]);
    if (title) metaPairs.push(["Title", title]);
    if (birth) metaPairs.push(["Born", birth]);
    if (rank) metaPairs.push(["National rank", "#" + rank]);
    if (klass) metaPairs.push(["Class", klass]);
  }
  if (ccData) {
    const p = ccData.profile;
    metaPairs.push(["Chess.com", "@" + (p.username || chesscomUser)]);
    if (p.title) metaPairs.push(["Chess.com title", p.title]);
    if (ccData.country?.name) metaPairs.push(["Country", ccData.country.name]);
    if (p.location) metaPairs.push(["Location", p.location]);
    if (p.joined) metaPairs.push(["Joined chess.com", formatDate(p.joined)]);
    if (p.followers != null) metaPairs.push(["Followers", String(p.followers)]);
  }

  for (const [k, v] of metaPairs) {
    if (!v) continue;
    const div = document.createElement("div");
    div.className = "kv";
    div.innerHTML = `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`;
    els.meta.appendChild(div);
  }

  els.sources.innerHTML = "";
  if (icfData?.sourceUrl) {
    els.sources.appendChild(makeSourceLink(icfData.sourceUrl, "View on chess.org.il"));
  }
  if (ccData?.sourceUrl) {
    els.sources.appendChild(makeSourceLink(ccData.sourceUrl, "View on chess.com"));
  }

  if (icfData || ccData) els.card.classList.remove("hidden");
}

function makeSourceLink(href, text) {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = text + " ↗";
  a.className = "source-link";
  return a;
}

function renderIcf(result) {
  if (!result) {
    setSectionStatus(els.icfStatus, "");
    return;
  }
  if (result.error) {
    setSectionStatus(els.icfStatus, "Couldn't load ICF data — " + result.error, "error");
    return;
  }
  setSectionStatus(els.icfStatus, "");
  const defs = [
    { key: "standard", label: "Standard", cls: "" },
    { key: "rapid", label: "Rapid", cls: "rapid" },
    { key: "blitz", label: "Blitz", cls: "blitz" },
  ];
  els.icfGrid.innerHTML = "";
  for (const r of defs) {
    const v = result.ratings[r.key];
    // The ICF profile page only exposes a single Israeli rating today;
    // skip Rapid/Blitz cards when there's no value rather than show "—".
    if (v == null) continue;
    let sub = "Israeli Chess Federation";
    if (r.key === "standard" && result.ratings.standardProjected != null) {
      const diff = result.ratings.standardProjected - v;
      const sign = diff > 0 ? "+" : "";
      sub = `expected ${result.ratings.standardProjected} (${sign}${diff})`;
    }
    els.icfGrid.appendChild(ratingCard({
      label: r.label,
      value: v,
      sub,
      cls: r.cls,
    }));
  }

  lastTournaments = result.tournaments.rows;
  lastTHeaders = result.tournaments.headers;
  renderTournaments(lastTournaments, lastTHeaders);
}

function renderChessCom(result) {
  if (!result) {
    setSectionStatus(els.chesscomStatus, "");
    return;
  }
  if (result.error) {
    setSectionStatus(els.chesscomStatus, "Couldn't load chess.com data — " + result.error, "error");
    return;
  }
  setSectionStatus(els.chesscomStatus, "");
  const s = result.stats || {};
  const defs = [
    { key: "chess_rapid", label: "Rapid", cls: "rapid" },
    { key: "chess_blitz", label: "Blitz", cls: "blitz" },
    { key: "chess_bullet", label: "Bullet", cls: "bullet" },
    { key: "chess_daily", label: "Daily", cls: "daily" },
    { key: "tactics", label: "Tactics", cls: "tactics" },
    { key: "puzzle_rush", label: "Puzzle Rush", cls: "puzzle" },
  ];
  els.chesscomGrid.innerHTML = "";
  for (const d of defs) {
    const obj = s[d.key];
    if (!obj) continue;
    const current = obj.last?.rating ?? null;
    const best = obj.best?.rating ?? obj.highest?.rating ?? null;
    const rushBest = obj.best?.score ?? null;

    let value, sub;
    if (d.key === "tactics") {
      value = obj.highest?.rating ?? null;
      const low = obj.lowest?.rating;
      sub = low != null ? `low ${low}` : "";
    } else if (d.key === "puzzle_rush") {
      value = rushBest;
      sub = rushBest != null ? "best score" : "";
    } else {
      value = current;
      sub = best != null ? `best ${best}` : "";
    }
    els.chesscomGrid.appendChild(ratingCard({
      label: d.label,
      value,
      sub: sub || "chess.com",
      cls: d.cls,
    }));
  }

  // Win/loss/draw records for games modes.
  els.chesscomRecords.innerHTML = "";
  const modes = [
    { key: "chess_rapid", label: "Rapid" },
    { key: "chess_blitz", label: "Blitz" },
    { key: "chess_bullet", label: "Bullet" },
    { key: "chess_daily", label: "Daily" },
  ];
  const recordRows = modes
    .map((m) => ({ label: m.label, rec: s[m.key]?.record }))
    .filter((x) => x.rec);
  if (recordRows.length) {
    const table = document.createElement("div");
    table.className = "records-grid";
    table.innerHTML = `
      <div class="records-head">Games</div>
      <div class="records-head">Wins</div>
      <div class="records-head">Losses</div>
      <div class="records-head">Draws</div>
    `;
    for (const { label, rec } of recordRows) {
      const total = (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0);
      table.insertAdjacentHTML("beforeend", `
        <div class="records-mode">${escapeHtml(label)} <span class="total">${total}</span></div>
        <div class="records-cell win">${rec.win ?? 0}</div>
        <div class="records-cell loss">${rec.loss ?? 0}</div>
        <div class="records-cell draw">${rec.draw ?? 0}</div>
      `);
    }
    els.chesscomRecords.appendChild(table);
  }
}

function ratingCard({ label, value, sub, cls }) {
  const card = document.createElement("div");
  card.className = "rating-card " + (cls || "");
  const valueHtml = value == null
    ? `<div class="value missing">—</div>`
    : `<div class="value">${escapeHtml(String(value))}</div>`;
  card.innerHTML = `
    <div class="label">${escapeHtml(label)}</div>
    ${valueHtml}
    <div class="sub">${escapeHtml(sub || "")}</div>
  `;
  return card;
}

function renderTournaments(rows, headers) {
  const q = cleanText(els.search.value).toLowerCase();
  els.theadRow.innerHTML = "";
  if (!headers || headers.length === 0) {
    headers = rows[0] ? rows[0].map((_, i) => `Col ${i + 1}`) : ["Tournament"];
  }
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = translateHeader(h) || "";
    els.theadRow.appendChild(th);
  }

  els.tbody.innerHTML = "";
  const visible = q
    ? rows.filter((r) => r.some((c) => (c || "").toLowerCase().includes(q)))
    : rows;

  if (!rows.length) {
    els.empty.textContent = "No tournaments found.";
    els.empty.classList.remove("hidden");
    return;
  }
  if (visible.length === 0) {
    els.empty.textContent = "No tournaments match the search.";
    els.empty.classList.remove("hidden");
    return;
  }
  els.empty.classList.add("hidden");

  for (const r of visible) {
    const tr = document.createElement("tr");
    for (let i = 0; i < headers.length; i++) {
      const td = document.createElement("td");
      td.textContent = r[i] != null ? translateCell(r[i]) : "";
      tr.appendChild(td);
    }
    els.tbody.appendChild(tr);
  }
}

function formatDate(epochSeconds) {
  if (!epochSeconds) return "";
  try {
    return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    });
  } catch { return ""; }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}
