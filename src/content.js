// Vinted NL/BE-filter — content script
// Bepaalt per artikel op de pagina het land van de verkoper en verbergt
// (of dimt) artikelen van buiten de gekozen landen.
//
// Gegevensbronnen, in volgorde van voorkeur:
//  1. De zoekresultaten die Vinted al in de pagina meestuurt (server-render),
//     en de API-antwoorden die page-hook.js onderschept: artikel-ID -> verkopers-ID.
//  2. /api/v2/users/<id> voor het land van de verkoper (gecachet, gedoseerd).
//  3. Uitwijk: de artikelpagina zelf ophalen om het verkopers-ID te vinden.
(() => {
  "use strict";
  if (window.__vnbfContent) return;
  window.__vnbfContent = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const hasStorage = !!(api && api.storage && api.storage.local);
  // Firefox: content.fetch doet het verzoek als de pagina zelf (met cookies).
  const pageFetch =
    typeof content !== "undefined" && content && typeof content.fetch === "function"
      ? content.fetch.bind(content)
      : window.fetch.bind(window);

  const DEFAULTS = {
    enabled: true,
    countries: ["NL", "BE"],
    mode: "hide", // "hide" | "dim"
    showUnknown: true,
    badges: true,
    showPill: true,
  };
  const USER_TTL = 60 * 864e5; // 60 dagen
  const ITEM_TTL = 30 * 864e5; // 30 dagen
  const MAX_ENTRIES = 30000;
  const FALLBACK_DELAY = 2500; // ms wachten op API-gegevens voor we de artikelpagina ophalen

  let settings = { ...DEFAULTS };
  let reveal = false; // tijdelijk verborgen artikelen gedimd tonen

  /** itemId -> { u: userId, t } */
  const items = new Map();
  /** userId -> { c: "NL", city: "Utrecht", t } */
  const users = new Map();
  const failedUsers = new Set();
  const failedItems = new Set();
  const pendingUsers = new Set();
  const pendingItems = new Set();
  const firstSeen = new Map(); // itemId -> timestamp

  // ---------- opslag ----------
  async function loadSettings() {
    if (!hasStorage) return;
    try {
      const s = await api.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...s };
    } catch (_) {}
  }

  async function loadCache() {
    if (!hasStorage) return;
    try {
      const { vnbfUsers = {}, vnbfItems = {} } = await api.storage.local.get(["vnbfUsers", "vnbfItems"]);
      const now = Date.now();
      for (const [k, v] of Object.entries(vnbfUsers)) if (now - v.t < USER_TTL) users.set(+k, v);
      for (const [k, v] of Object.entries(vnbfItems)) if (now - v.t < ITEM_TTL && !items.has(+k)) items.set(+k, v);
    } catch (_) {}
  }

  function prune(map) {
    if (map.size <= MAX_ENTRIES) return;
    const sorted = [...map.entries()].sort((a, b) => a[1].t - b[1].t);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) map.delete(sorted[i][0]);
  }

  let saveTimer = null;
  function saveCacheSoon() {
    if (!hasStorage || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      prune(users);
      prune(items);
      try {
        await api.storage.local.set({
          vnbfUsers: Object.fromEntries(users),
          vnbfItems: Object.fromEntries(items),
        });
      } catch (_) {}
    }, 2000);
  }

  // ---------- gedoseerde verzoeken ----------
  // Vinted staat ongeveer 30 verzoeken per minuut toe op /api/v2/users
  // (daarna 429 met Retry-After: 60). We blijven daar ruim onder, zodat er
  // ruimte overblijft voor je eigen gebruik van de site.
  const RATE = 24;
  const WINDOW = 60000;
  const limiter = { active: 0, max: 2, gap: 200, last: 0, pausedUntil: 0, backoff: 0, queue: [], sent: [], timer: null };

  function schedule(key, task, urgent) {
    return new Promise((resolve, reject) => {
      limiter.queue.push({ key, task, resolve, reject, urgent: !!urgent });
      pump();
    });
  }

  function promote(key) {
    for (const job of limiter.queue) if (job.key === key) job.urgent = true;
  }

  function pump() {
    for (;;) {
      if (limiter.active >= limiter.max || !limiter.queue.length) return;
      const now = Date.now();
      while (limiter.sent.length && now - limiter.sent[0] > WINDOW) limiter.sent.shift();
      const windowWait = limiter.sent.length >= RATE ? limiter.sent[0] + WINDOW - now + 50 : 0;
      const wait = Math.max(limiter.pausedUntil - now, limiter.last + limiter.gap - now, windowWait, 0);
      if (wait > 0) {
        if (!limiter.timer) limiter.timer = setTimeout(() => { limiter.timer = null; pump(); renderSoon(); }, wait);
        return;
      }
      let idx = limiter.queue.findIndex((j) => j.urgent);
      if (idx === -1) idx = 0;
      const job = limiter.queue.splice(idx, 1)[0];
      limiter.active++;
      limiter.last = now;
      limiter.sent.push(now);
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => { limiter.active--; pump(); });
    }
  }

  class RetryError extends Error {}
  class CancelError extends Error {}

  // Opdrachten voor artikelen die niet meer op de pagina staan (bijv. na
  // doorbladeren) uit de wachtrij halen, zodat ze geen verzoeken verspillen.
  function dropUnneeded(needed) {
    limiter.queue = limiter.queue.filter((job) => {
      if (needed.has(job.key)) return true;
      job.reject(new CancelError(job.key));
      return false;
    });
  }

  function onRateLimited(res) {
    const ra = parseInt(res.headers.get("retry-after") || "0", 10) * 1000;
    limiter.backoff = Math.min(60000, Math.max(ra, limiter.backoff ? limiter.backoff * 2 : 3000));
    limiter.pausedUntil = Date.now() + limiter.backoff;
    throw new RetryError("429");
  }

  async function withRetry(key, fn, urgent, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try {
        const out = await schedule(key, fn, urgent);
        limiter.backoff = 0;
        return out;
      } catch (e) {
        if (!(e instanceof RetryError) || i === tries - 1) throw e;
      }
    }
  }

  async function fetchUser(uid) {
    const res = await pageFetch(`${location.origin}/api/v2/users/${uid}`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (res.status === 429) onRateLimited(res);
    if (res.status === 404) return { c: "?", city: "", t: Date.now() };
    if (res.status >= 500) throw new RetryError(String(res.status));
    if (!res.ok) throw new Error(String(res.status));
    const u = (await res.json()).user || {};
    return {
      c: String(u.country_iso_code || u.country_code || "?").toUpperCase(),
      city: u.expose_location === false ? "" : (u.city || ""),
      t: Date.now(),
    };
  }

  async function fetchItemOwner(itemId) {
    const res = await pageFetch(`${location.origin}/items/${itemId}`, { credentials: "include" });
    if (res.status === 429) onRateLimited(res);
    if (res.status >= 500) throw new RetryError(String(res.status));
    if (!res.ok) throw new Error(String(res.status));
    const t = await res.text();
    const m =
      t.match(/offender_id=(\d+)/) ||
      t.match(/\\?"sellerId\\?":(\d+)/) ||
      t.match(/\\?"seller_id\\?":\\?"?(\d+)/);
    if (!m) throw new Error("geen verkoper gevonden");
    return +m[1];
  }

  function requestUser(uid, urgent) {
    if (pendingUsers.has(uid)) { if (urgent) promote("u" + uid); return; }
    if (failedUsers.has(uid) || users.has(uid)) return;
    pendingUsers.add(uid);
    withRetry("u" + uid, () => fetchUser(uid), urgent)
      .then((u) => { users.set(uid, u); saveCacheSoon(); })
      .catch((e) => { if (!(e instanceof CancelError)) failedUsers.add(uid); })
      .finally(() => { pendingUsers.delete(uid); renderSoon(); });
  }

  function requestItemOwner(itemId, urgent) {
    if (pendingItems.has(itemId)) { if (urgent) promote("i" + itemId); return; }
    if (failedItems.has(itemId) || items.has(itemId)) return;
    pendingItems.add(itemId);
    withRetry("i" + itemId, () => fetchItemOwner(itemId), urgent)
      .then((uid) => { items.set(itemId, { u: uid, t: Date.now() }); saveCacheSoon(); })
      .catch((e) => { if (!(e instanceof CancelError)) failedItems.add(itemId); })
      .finally(() => { pendingItems.delete(itemId); renderSoon(); });
  }

  // ---------- artikel -> verkoper koppelen ----------
  function addPairs(pairs) {
    const t = Date.now();
    let added = 0;
    for (const [i, u] of pairs) {
      if (!i || !u) continue;
      const cur = items.get(i);
      if (!cur || cur.u !== u) { items.set(i, { u, t }); added++; }
    }
    if (added) { saveCacheSoon(); renderSoon(); }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.type !== "vnbf:pairs") return;
    if (Array.isArray(e.data.pairs)) addPairs(e.data.pairs);
  });

  // Server-gerenderde zoekresultaten (Next.js / React Server Components)
  const parsedScripts = new WeakSet();
  function parseInlineScripts() {
    for (const s of document.scripts) {
      if (parsedScripts.has(s)) continue;
      const txt = s.textContent;
      if (!txt) continue; // nog aan het laden; later opnieuw proberen
      parsedScripts.add(s);
      if (!txt.startsWith("self.__next_f") || txt.indexOf("productItem") === -1) continue;
      const t = txt.replace(/\\"/g, '"');
      const parts = t.split('"productItem":{"id":');
      const pairs = [];
      for (let i = 1; i < parts.length; i++) {
        const id = parseInt(parts[i], 10);
        const m = parts[i].match(/"user":\{"id":(\d+)/);
        if (id && m) pairs.push([id, +m[1]]);
      }
      addPairs(pairs);
    }
  }

  // ---------- weergave ----------
  const CARD_RE = /^product-item-id-(\d+)$/;

  function cellFor(card) {
    return (
      card.closest('[data-testid="grid-item"]') ||
      card.closest('[class*="feed-grid__item"]') ||
      card.closest('[class*="horizontal-scroll__item"]') ||
      card
    );
  }

  function statusFor(itemId, urgent) {
    const rec = items.get(itemId);
    if (!rec) {
      if (failedItems.has(itemId)) return { s: "unknown" };
      const seen = firstSeen.get(itemId) || Date.now();
      if (!firstSeen.has(itemId)) firstSeen.set(itemId, seen);
      if (Date.now() - seen > FALLBACK_DELAY) requestItemOwner(itemId, urgent);
      else renderLater(FALLBACK_DELAY + 50);
      return { s: "pending" };
    }
    const u = users.get(rec.u);
    if (!u) {
      if (failedUsers.has(rec.u)) return { s: "unknown" };
      requestUser(rec.u, urgent);
      return { s: "pending" };
    }
    if (u.c === "?") return { s: "unknown" };
    return { s: settings.countries.includes(u.c) ? "in" : "out", c: u.c, city: u.city };
  }

  function badgeHost(card) {
    const link = card.querySelector('[data-testid$="--overlay-link"]');
    const host = (link && link.parentElement) || card;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    return host;
  }

  function setBadge(card, st) {
    let b = card.querySelector(":scope .vnbf-badge");
    if (!settings.badges || !settings.enabled) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement("span");
      b.className = "vnbf-badge";
      badgeHost(card).appendChild(b);
    }
    let text = "…";
    if (st.s === "unknown") text = "?";
    else if (st.c) text = st.city && st.s === "in" ? `${st.c} · ${st.city}` : st.c;
    if (b.textContent !== text) b.textContent = text;
    b.dataset.state = st.s;
    b.title =
      st.s === "pending" ? "Land van verkoper wordt opgehaald…" :
      st.s === "unknown" ? "Land van verkoper onbekend" :
      `Verkoper uit ${st.c}${st.city ? " (" + st.city + ")" : ""}`;
  }

  let counts = { in: 0, out: 0, pending: 0, unknown: 0 };

  function render() {
    parseInlineScripts();
    const root = document.documentElement;
    root.classList.toggle("vnbf-off", !settings.enabled);
    root.classList.toggle("vnbf-mode-dim", settings.mode === "dim");
    root.classList.toggle("vnbf-reveal", reveal);
    root.classList.toggle("vnbf-hide-unknown", !settings.showUnknown);

    const c = { in: 0, out: 0, pending: 0, unknown: 0 };
    const vh = window.innerHeight || 800;
    const needed = new Set();
    for (const card of document.querySelectorAll('[data-testid^="product-item-id-"]')) {
      const m = CARD_RE.exec(card.getAttribute("data-testid"));
      if (!m) continue;
      const id = +m[1];
      let urgent = false;
      if (settings.enabled && !users.has(items.get(id)?.u)) {
        const r = card.getBoundingClientRect();
        urgent = r.bottom > -300 && r.top < vh + 600; // in of vlak bij beeld
      }
      const st = settings.enabled ? statusFor(id, urgent) : { s: "in" };
      if (st.s === "pending") {
        const rec = items.get(id);
        needed.add(rec ? "u" + rec.u : "i" + id);
      }
      const cell = cellFor(card);
      if (cell.dataset.vnbf !== st.s) cell.dataset.vnbf = st.s;
      cell.classList.add("vnbf-cell");
      setBadge(card, st);
      c[st.s]++;
    }
    if (settings.enabled) dropUnneeded(needed);
    counts = c;
    updatePill();
  }

  let laterTimer = null;
  function renderLater(ms) {
    if (laterTimer) return;
    laterTimer = setTimeout(() => { laterTimer = null; renderSoon(); }, ms);
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  let renderQueued = false;
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // ---------- statuslabel ----------
  let pill = null;
  function updatePill() {
    const total = counts.in + counts.out + counts.pending + counts.unknown;
    if (!settings.showPill || !document.body || total === 0) {
      if (pill) pill.hidden = true;
      return;
    }
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "vnbf-pill";
      pill.innerHTML =
        '<button type="button" class="vnbf-pill__toggle" title="Filter aan/uit"></button>' +
        '<span class="vnbf-pill__text"></span>' +
        '<button type="button" class="vnbf-pill__reveal" title="Verborgen artikelen tijdelijk tonen"></button>';
      pill.querySelector(".vnbf-pill__toggle").addEventListener("click", async () => {
        settings.enabled = !settings.enabled;
        if (hasStorage) { try { await api.storage.sync.set({ enabled: settings.enabled }); } catch (_) {} }
        renderSoon();
      });
      pill.querySelector(".vnbf-pill__reveal").addEventListener("click", () => {
        reveal = !reveal;
        renderSoon();
      });
      document.body.appendChild(pill);
    }
    pill.hidden = false;
    const label = settings.countries.join("/") || "geen land";
    const toggle = pill.querySelector(".vnbf-pill__toggle");
    setText(toggle, settings.enabled ? label : `${label} uit`);
    toggle.dataset.on = String(settings.enabled);
    const parts = [];
    if (settings.enabled) {
      const hiddenUnknown = settings.showUnknown ? 0 : counts.unknown;
      parts.push(`${counts.in + (settings.showUnknown ? counts.unknown : 0)} getoond`);
      parts.push(`${counts.out + hiddenUnknown} ${settings.mode === "dim" ? "gedimd" : "verborgen"}`);
      if (counts.pending) {
        const mins = Math.ceil(limiter.queue.length / RATE);
        parts.push(`${counts.pending} laden…${mins > 1 ? ` (~${mins} min)` : ""}`);
      }
    } else {
      parts.push("filter staat uit");
    }
    setText(pill.querySelector(".vnbf-pill__text"), parts.join(" · "));
    const rv = pill.querySelector(".vnbf-pill__reveal");
    rv.hidden = !settings.enabled || settings.mode === "dim" || counts.out + (settings.showUnknown ? 0 : counts.unknown) === 0;
    setText(rv, reveal ? "verberg" : "toon");
  }

  // ---------- opstarten ----------
  if (hasStorage) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") {
        for (const [k, v] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = v.newValue ?? DEFAULTS[k];
        renderSoon();
      }
      if (area === "local" && changes.vnbfUsers && !changes.vnbfUsers.newValue) {
        // cache gewist via het pop-upmenu
        users.clear(); items.clear(); failedUsers.clear(); failedItems.clear();
        renderSoon();
      }
    });
  }

  const ours = (n) =>
    n.nodeType === 1
      ? n.classList.contains("vnbf-badge") || n.classList.contains("vnbf-pill") || !!n.closest(".vnbf-pill")
      : !!(n.parentElement && n.parentElement.closest(".vnbf-pill, .vnbf-badge"));
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (ours(m.target)) continue;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (nodes.length && nodes.every(ours)) continue;
      renderSoon();
      return;
    }
  });

  (async () => {
    await Promise.all([loadSettings(), loadCache()]);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    renderSoon();
    document.addEventListener("DOMContentLoaded", renderSoon);
    let scrollTimer = null;
    window.addEventListener("scroll", () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => { scrollTimer = null; renderSoon(); }, 300);
    }, { passive: true });
    window.addEventListener("load", renderSoon);
  })();
})();
