/* Chess Stats Dashboard
 * Fetches an Israeli Chess Federation (chess.org.il) player page in the
 * browser through public CORS proxies, parses the HTML and renders a
 * dashboard of ratings, ranking and tournaments.
 */

const DEFAULT_ID = "207079";

// Public CORS proxies, tried in order. The code falls back if one fails.
// All of these return the raw body of the target URL.
const PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://cors.isomorphic-git.org/${url}`,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];

const els = {
  form: document.getElementById("player-form"),
  input: document.getElementById("player-id"),
  status: document.getElementById("status"),
  sourceLink: document.getElementById("source-link"),
  card: document.getElementById("player-card"),
  name: document.getElementById("player-name"),
  meta: document.getElementById("player-meta"),
  ratingGrid: document.getElementById("rating-grid"),
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
  const id = (els.input.value || "").trim();
  if (!/^\d+$/.test(id)) {
    setStatus("Enter a numeric player ID.", "error");
    return;
  }
  const hash = `#id=${id}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
  load(id);
});

els.search.addEventListener("input", () => renderTournaments(lastTournaments, lastTHeaders));

window.addEventListener("DOMContentLoaded", () => {
  const m = location.hash.match(/id=(\d+)/);
  const id = m ? m[1] : DEFAULT_ID;
  els.input.value = id;
  load(id);
});

function setStatus(msg, kind) {
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? " " + kind : "");
}

async function load(id) {
  const targetUrl = `https://www.chess.org.il/Players/Player.aspx?Id=${id}`;
  els.sourceLink.href = targetUrl;
  setStatus("Loading player data…", "loading");
  els.card.classList.add("hidden");
  els.ratingGrid.innerHTML = "";
  els.tbody.innerHTML = "";
  els.empty.classList.add("hidden");

  let html, usedProxy;
  const errors = [];
  for (const makeUrl of PROXIES) {
    const proxyUrl = makeUrl(targetUrl);
    try {
      const resp = await fetch(proxyUrl, { redirect: "follow" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      html = await resp.text();
      if (!html || html.length < 500) throw new Error("empty response");
      usedProxy = proxyUrl;
      break;
    } catch (err) {
      errors.push(`${new URL(proxyUrl).hostname}: ${err.message}`);
    }
  }

  if (!html) {
    setStatus(
      "Couldn't reach chess.org.il through any public proxy. Tried: " +
        errors.join(" · "),
      "error"
    );
    return;
  }

  try {
    const data = parsePlayer(html);
    render(id, data);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("Failed to parse page: " + err.message, "error");
  }
}

/* ---------- parsing ---------- */

function parsePlayer(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const data = {
    name: extractName(doc),
    fields: extractLabelledFields(doc),
    ratings: extractRatings(doc),
    tournaments: extractTournaments(doc),
  };
  return data;
}

function extractName(doc) {
  // Try several strategies for the player name.
  // 1. <h1> / <h2> near the top
  const headings = doc.querySelectorAll("h1, h2, .player-name, #MainContent_lblName, [id$='lblName']");
  for (const h of headings) {
    const t = cleanText(h.textContent);
    if (t && t.length > 1 && t.length < 80) return t;
  }
  // 2. <title>
  const t = cleanText(doc.querySelector("title")?.textContent || "");
  return t || "";
}

/* Look through the page for label/value pairs.
 * Chess.org.il renders labels like "מד כושר" / "FIDE" in one cell and
 * values in the next, either as table rows or as adjacent spans. */
function extractLabelledFields(doc) {
  const fields = {};

  // Strategy A: table rows with two cells (label, value)
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

  // Strategy B: ASP.NET WebForms uses <span id="...lblX"> for values,
  // often preceded by a literal label. Collect those too.
  for (const span of doc.querySelectorAll("span[id]")) {
    const id = span.id || "";
    const m = id.match(/lbl(\w+)$/i);
    if (!m) continue;
    const key = m[1];
    const v = cleanText(span.textContent);
    if (v) fields["_" + key] = v;
  }

  return fields;
}

/* Map common label aliases (Hebrew + English) to canonical keys. */
const LABEL_ALIASES = {
  name: ["שם", "Name", "שם השחקן", "Player", "_Name", "_PlayerName", "_FullName"],
  fideId: ["FIDE", "FIDE ID", "מספר FIDE", "מס FIDE", "מס' FIDE", "_FIDE", "_FideId", "_FideID"],
  playerId: ["מספר שחקן", "מס שחקן", "מס' שחקן", "ID", "Player ID", "_Id", "_PlayerId"],
  club: ["מועדון", "Club", "אגודה", "_Club"],
  city: ["עיר", "City", "_City"],
  birth: ["תאריך לידה", "שנת לידה", "לידה", "Birth", "Year of birth", "_BirthYear", "_Birth"],
  title: ["תואר", "Title", "_Title"],
  standard: ["מד כושר", "רגיל", "Standard", "Classical", "דירוג", "_Rating", "_Std", "_Standard"],
  rapid: ["מהיר", "Rapid", "_Rapid"],
  blitz: ["בזק", "Blitz", "_Blitz"],
  nationalRank: ["דירוג ארצי", "מקום", "Rank", "דרגה"],
  gender: ["מין", "Gender"],
};

function resolveField(fields, key) {
  const aliases = LABEL_ALIASES[key] || [];
  for (const a of aliases) {
    if (fields[a]) return fields[a];
  }
  // Also try case-insensitive / partial matches for label-style keys.
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
  return {
    standard: pickNumber(resolveField(fields, "standard")),
    rapid: pickNumber(resolveField(fields, "rapid")),
    blitz: pickNumber(resolveField(fields, "blitz")),
    nationalRank: resolveField(fields, "nationalRank"),
  };
}

/* Pick the table that most likely contains tournament history.
 * Heuristic: the table on the page with the most rows, where at least one
 * cell in a header or first row looks like a date. */
function extractTournaments(doc) {
  const tables = [...doc.querySelectorAll("table")];
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
  let score = rows.length; // more rows = better
  const sample = rows.slice(0, Math.min(rows.length, 6));
  const cellText = sample
    .map((r) => [...r.querySelectorAll("td,th")].map((c) => c.textContent).join(" "))
    .join(" ");
  if (/\b(19|20)\d{2}\b/.test(cellText)) score += 6; // contains a year
  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(cellText)) score += 6; // contains a date
  // Hebrew headers for tournament tables
  if (/תאריך|טורניר|תוצאה|מקום|שינוי/.test(cellText)) score += 10;
  // English headers
  if (/tournament|date|result|place|rating|score/i.test(cellText)) score += 6;
  // Penalise tiny tables used for layout
  if (rows.length < 3) score -= 4;
  return score;
}

function cleanText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------- rendering ---------- */

function render(id, data) {
  // Player card
  const fields = data.fields;
  const displayName =
    data.name ||
    resolveField(fields, "name") ||
    `Player #${id}`;

  els.name.textContent = displayName;
  els.meta.innerHTML = "";
  const metaPairs = [
    ["Player ID", id],
    ["FIDE ID", resolveField(fields, "fideId")],
    ["Club", resolveField(fields, "club")],
    ["City", resolveField(fields, "city")],
    ["Title", resolveField(fields, "title")],
    ["Born", resolveField(fields, "birth")],
    ["National rank", resolveField(fields, "nationalRank")],
  ];
  for (const [k, v] of metaPairs) {
    if (!v) continue;
    const div = document.createElement("div");
    div.className = "kv";
    div.innerHTML = `${escapeHtml(k)}: <strong>${escapeHtml(v)}</strong>`;
    els.meta.appendChild(div);
  }
  els.card.classList.remove("hidden");

  // Ratings
  els.ratingGrid.innerHTML = "";
  const ratingDefs = [
    { key: "standard", label: "Standard", cls: "" },
    { key: "rapid", label: "Rapid", cls: "rapid" },
    { key: "blitz", label: "Blitz", cls: "blitz" },
  ];
  for (const r of ratingDefs) {
    const v = data.ratings[r.key];
    const card = document.createElement("div");
    card.className = "rating-card " + r.cls;
    const value = v == null
      ? `<div class="value missing">—</div>`
      : `<div class="value">${v}</div>`;
    card.innerHTML = `
      <div class="label">${r.label}</div>
      ${value}
      <div class="sub">Israeli Chess Federation</div>
    `;
    els.ratingGrid.appendChild(card);
  }

  // Tournaments
  lastTournaments = data.tournaments.rows;
  lastTHeaders = data.tournaments.headers;
  renderTournaments(lastTournaments, lastTHeaders);

  // Raw dump for debugging
  els.raw.textContent = JSON.stringify(
    {
      ratings: data.ratings,
      name: displayName,
      fields: data.fields,
      tournaments: {
        headers: data.tournaments.headers,
        count: data.tournaments.rows.length,
      },
    },
    null,
    2
  );
}

function renderTournaments(rows, headers) {
  const q = cleanText(els.search.value).toLowerCase();
  els.theadRow.innerHTML = "";
  if (!headers || headers.length === 0) {
    headers = rows[0] ? rows[0].map((_, i) => `Col ${i + 1}`) : ["Tournament"];
  }
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h || "";
    els.theadRow.appendChild(th);
  }

  els.tbody.innerHTML = "";
  const visible = q
    ? rows.filter((r) => r.some((c) => (c || "").toLowerCase().includes(q)))
    : rows;

  if (visible.length === 0) {
    els.empty.classList.remove("hidden");
    return;
  }
  els.empty.classList.add("hidden");

  for (const r of visible) {
    const tr = document.createElement("tr");
    for (let i = 0; i < headers.length; i++) {
      const td = document.createElement("td");
      td.textContent = r[i] != null ? r[i] : "";
      tr.appendChild(td);
    }
    els.tbody.appendChild(tr);
  }
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
