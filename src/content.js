// Vinted NL/BE-filter — content script
// Bepaalt per artikel op de pagina het land van de verkoper en verbergt
// (of dimt) artikelen van buiten de gekozen landen.
//
// Gegevensbronnen, in volgorde van voorkeur:
//  1. De zoekresultaten die Vinted al in de pagina meestuurt (server-render),
//     en de API-antwoorden die page-hook.js onderschept: artikel-ID -> verkopers-ID.
//  2. /api/v2/users/<id> voor het land van de verkoper (gecachet, gedoseerd).
//  3. Uitwijk: de artikelpagina zelf ophalen om het verkopers-ID te vinden.
//
// Daarnaast vult de extensie de pagina aan met artikelen van volgende pagina's
// als er na het filteren te weinig overblijven (zie "pagina aanvullen").
//
// Onderhoud: alle plekken die afhangen van hoe Vinted's site in elkaar zit, zijn
// gemarkeerd met  VINTED-AFHANKELIJK. Werkt de extensie niet meer na een
// wijziging bij Vinted, zoek dan eerst op dat woord (ook in page-hook.js en
// content.css).
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
    autoFill: true,
    langPrefilter: true,
  };
  const AUTOFILL_TARGET = 36; // aanvullen tot er minstens zoveel artikelen zichtbaar zijn
  const AUTOFILL_MAX_PAGES = 3; // maximaal zoveel extra pagina's automatisch
  const USER_TTL = 60 * 864e5; // 60 dagen
  const ITEM_TTL = 30 * 864e5; // 30 dagen
  const MAX_ENTRIES = 30000; // max. items per cache (≈1 MB in browser.storage.local)
  const FALLBACK_DELAY = 2500; // ms wachten op API-gegevens voor we de artikelpagina ophalen

  let settings = { ...DEFAULTS };
  let reveal = false; // tijdelijk verborgen artikelen gedimd tonen (knop 'toon' in statuslabel)

  // ---------- toestand ----------
  // Alles wat we weten zit in twee Maps; de rest zijn hulpsets om dubbel werk te voorkomen.

  /** itemId -> { u: userId, t } */
  const items = new Map();
  /** userId -> { c: "NL", city: "Utrecht", t } */
  const users = new Map();
  const failedUsers = new Set(); // opzoeken definitief mislukt (deze sessie niet opnieuw)
  const failedItems = new Set();
  const pendingUsers = new Set(); // userIds in de wachtrij of onderweg
  const pendingItems = new Set(); // itemIds waarvoor de artikelpagina wordt opgehaald
  const firstSeen = new Map(); // itemId -> moment eerst gezien (voor FALLBACK_DELAY)

  // ---------- opslag ----------
  /** Instellingen uit browser.storage.sync laden (synchroniseert tussen je apparaten). */
  async function loadSettings() {
    if (!hasStorage) return;
    try {
      const s = await api.storage.sync.get(DEFAULTS);
      settings = { ...DEFAULTS, ...s };
    } catch (_) {}
  }

  /** Opgeslagen verkopers en koppelingen laden; verlopen items (TTL) worden overgeslagen. */
  async function loadCache() {
    if (!hasStorage) return;
    try {
      const { vnbfUsers = {}, vnbfItems = {} } = await api.storage.local.get(["vnbfUsers", "vnbfItems"]);
      const now = Date.now();
      for (const [k, v] of Object.entries(vnbfUsers)) if (now - v.t < USER_TTL) users.set(+k, v);
      for (const [k, v] of Object.entries(vnbfItems)) if (now - v.t < ITEM_TTL && !items.has(+k)) items.set(+k, v);
    } catch (_) {}
  }

  /** Houdt een cache onder MAX_ENTRIES door de oudste items (op tijdstempel t) te verwijderen. */
  function prune(map) {
    if (map.size <= MAX_ENTRIES) return;
    const sorted = [...map.entries()].sort((a, b) => a[1].t - b[1].t);
    for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) map.delete(sorted[i][0]);
  }

  let saveTimer = null;
  /** Cache wegschrijven, maximaal één keer per 2 s (debounce), zodat we de opslag niet spammen. */
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
  const RATE = 24; // max. verzoeken per WINDOW (VINTED-AFHANKELIJK: hun limiet is ~30/min)
  const WINDOW = 60000; // glijdend venster van 60 s
  const limiter = { active: 0, max: 2, gap: 200, last: 0, pausedUntil: 0, backoff: 0, queue: [], sent: [], timer: null };

  /**
   * Zet een verzoek in de wachtrij.
   * @param {string} key     Unieke sleutel: "u<userId>" of "i<itemId>". Gebruikt om te
   *                         prioriteren (promote) of te schrappen (dropUnneeded).
   * @param {Function} task  Async functie die het verzoek doet.
   * @param {number} prio    Prioriteit: lager = eerder (zie priorityFor()).
   * @returns {Promise}      Resultaat van task (of CancelError / RetryError).
   */
  function schedule(key, task, prio) {
    return new Promise((resolve, reject) => {
      limiter.queue.push({ key, task, resolve, reject, prio });
      pump();
    });
  }

  /** Prioriteit van een opdracht verhogen (lager getal), bijv. omdat je ernaartoe gescrold bent. */
  function promote(key, prio) {
    for (const job of limiter.queue) if (job.key === key && prio < job.prio) job.prio = prio;
  }

  /**
   * Hart van de wachtrij. Start zoveel opdrachten als mag, en anders een timer.
   * Regels, in deze volgorde:
   *  - nooit meer dan `max` tegelijk;
   *  - minstens `gap` ms tussen twee verzoeken;
   *  - nooit meer dan RATE verzoeken in de laatste WINDOW ms (glijdend venster);
   *  - na een 429 pauzeren tot `pausedUntil`.
   * Laagste prioriteitsgetal gaat eerst (zie priorityFor()); bij gelijke prioriteit
   * op volgorde van binnenkomst.
   */
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
      let idx = 0;
      for (let k = 1; k < limiter.queue.length; k++) if (limiter.queue[k].prio < limiter.queue[idx].prio) idx = k;
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

  /**
   * Vinted gaf 429 (te veel verzoeken). Pauzeer de hele wachtrij: Retry-After
   * als die er is, anders oplopend 3 s → 6 s → … → max. 60 s. Gooit RetryError,
   * zodat withRetry() het verzoek opnieuw inplant.
   */
  function onRateLimited(res) {
    const ra = parseInt(res.headers.get("retry-after") || "0", 10) * 1000;
    limiter.backoff = Math.min(60000, Math.max(ra, limiter.backoff ? limiter.backoff * 2 : 3000));
    limiter.pausedUntil = Date.now() + limiter.backoff;
    throw new RetryError("429");
  }

  /** Plant fn in via de wachtrij en probeert het tot `tries` keer bij een RetryError (429/5xx). */
  async function withRetry(key, fn, prio, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try {
        const out = await schedule(key, fn, prio);
        limiter.backoff = 0;
        return out;
      } catch (e) {
        if (!(e instanceof RetryError) || i === tries - 1) throw e;
      }
    }
  }

  /**
   * Haalt land en woonplaats van een verkoper op.
   * VINTED-AFHANKELIJK: endpoint /api/v2/users/<id> en de velden
   * user.country_iso_code / country_code / city / expose_location.
   * @returns {{c: string, city: string, t: number}}  c = ISO-landcode of "?" (onbekend).
   */
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

  /**
   * Uitwijk: haalt de artikelpagina op en zoekt daarin het verkopers-ID.
   * Zwaar (±1,5 MB per pagina), dus alleen als de normale bronnen niets opleveren.
   * VINTED-AFHANKELIJK: zoekt naar `offender_id=` (link 'Rapporteer artikel'),
   * `"sellerId":` of `"seller_id":` in de HTML.
   */
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

  /** Verkoper opzoeken als dat nog niet gebeurd/bezig is. Resultaat komt in `users`. */
  function requestUser(uid, prio) {
    if (pendingUsers.has(uid)) { promote("u" + uid, prio); return; }
    if (failedUsers.has(uid) || users.has(uid)) return;
    pendingUsers.add(uid);
    withRetry("u" + uid, () => fetchUser(uid), prio)
      .then((u) => { users.set(uid, u); saveCacheSoon(); })
      .catch((e) => { if (!(e instanceof CancelError)) failedUsers.add(uid); })
      .finally(() => { pendingUsers.delete(uid); renderSoon(); });
  }

  /** Verkoper van een artikel opzoeken via de artikelpagina (uitwijk). Resultaat in `items`. */
  function requestItemOwner(itemId, prio) {
    if (pendingItems.has(itemId)) { promote("i" + itemId, prio); return; }
    if (failedItems.has(itemId) || items.has(itemId)) return;
    pendingItems.add(itemId);
    withRetry("i" + itemId, () => fetchItemOwner(itemId), prio)
      .then((uid) => { items.set(itemId, { u: uid, t: Date.now() }); saveCacheSoon(); })
      .catch((e) => { if (!(e instanceof CancelError)) failedItems.add(itemId); })
      .finally(() => { pendingItems.delete(itemId); renderSoon(); });
  }

  // ---------- artikel -> verkoper koppelen ----------
  /**
   * Nieuwe koppelingen artikel → verkoper opslaan.
   * @param {Array<[number, number, string?]>} pairs  Lijst van [itemId, userId, titel].
   */
  function addPairs(pairs) {
    const t = Date.now();
    let added = 0;
    for (const [i, u, title] of pairs) {
      if (!i || !u) continue;
      if (title && !titles.has(i)) titles.set(i, title);
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
  /**
   * Leest de server-gerenderde zoekresultaten uit de <script>-tags van de pagina.
   * VINTED-AFHANKELIJK: Next.js zet data in `self.__next_f.push([...])`, met per
   * artikel `"productItem":{"id":…, …, "user":{"id":…}}` (aanhalingstekens ge-escaped).
   * We knippen op "productItem" en zoeken binnen elk stuk het eerste user-ID.
   */
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
        const tt = parts[i].match(/"title":"([^"]{1,300})"/);
        if (id && m) pairs.push([id, +m[1], tt ? tt[1] : ""]);
      }
      addPairs(pairs);
    }
  }

  // ---------- taal van de titel ----------
  // Snelle, lokale schatting van de taal van een titel. Wordt gebruikt om
  //  1. de volgorde van opzoeken te bepalen (Nederlands eerst, dan Engels, dan de rest);
  //  2. titels in een duidelijk andere taal voorlopig te verbergen tot het land bekend is.
  // Dit is een vuistregel, geen zekerheid: het land van de verkoper blijft leidend.
  // Een Franstalige Belg wordt eerst verborgen en verschijnt na controle alsnog.
  const titles = new Map(); // itemId -> titel
  const langs = new Map(); // itemId -> "nl" | "en" | "fr" | ... | "" (onbekend)

  const LANG_WORDS = {
    nl: "de het een en met van voor maat mt jurk broek trui jas jasje schoenen laarzen nieuw nieuwe zwart zwarte wit witte blauw blauwe rood rode groen groene grijs grijze bruin bruine roze heren dames meisje meisjes jongen jongens kinder kinderen vest rok tas sokken spijkerbroek leer leren wol wollen katoen nooit gedragen kaartje label mooie mooi leuke leuk lange korte mouw mouwen maanden jaar zgan nog niet maar ook zomer winter jurkje truitje shirtje setje stoel tafel kast lampje boek boeken speelgoed",
    en: "the and with for size dress jeans shirt tshirt jacket coat shoes new black white blue red green grey gray brown pink women womens woman men mens kids girl girls boy boys sweater jumper hoodie top skirt bag boots never worn tags tag long short sleeve sleeves oversized cute beautiful set baby months years summer winter",
    fr: "de en le la les des du et pull laine coton cuir haute coupe avec pour taille robe pantalon pull veste manteau chaussures neuf neuve noir noire blanc blanche bleu bleue rouge vert verte gris grise marron femme homme enfant fille garçon sac jupe manches très état jamais porté portée étiquette jolie joli bon tbe mois ans été hiver chemise baskets",
    de: "der die das und mit für größe grösse gr kleid hose jacke mantel schuhe neu neue schwarz schwarze weiß weiss weiße blau blaue rot rote grün grau braun damen herren mädchen junge tasche rock stiefel ärmel getragen etikett schöne schön sommer winter pullover hemd strickjacke",
    es: "de la el los las y con para talla vestido pantalón pantalones chaqueta abrigo zapatos nuevo nueva negro negra blanco blanca azul rojo roja verde gris marrón mujer hombre niña niño bolso falda manga mangas sin estrenar etiqueta bonito bonita camiseta sudadera zapatillas",
    it: "di da la il lo gli e con per taglia vestito pantaloni giacca cappotto scarpe nuovo nuova nero nera bianco bianca blu rosso rossa verde grigio marrone donna uomo bambina bambino borsa gonna maniche mai indossato etichetta bellissimo bellissima maglia maglione felpa",
    pl: "z i dla rozmiar sukienka spodnie kurtka płaszcz buty nowa nowy nowe czarna czarny biała biały niebieska damska damski męska męski dziecięca torebka spódnica sweter bluza koszula",
    pt: "de da do o os as e com para tamanho vestido calças casaco sapatos novo nova preto preta branco branca azul vermelho verde cinzento mulher homem menina menino saia mala camisola",
    lt: "dydis suknelė kelnės striukė batai naujas nauja juoda balta mėlyna moteriška vyriška",
  };
  const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v.split(" "))]));
  // Tekens die vrijwel alleen in bepaalde talen voorkomen
  const LANG_CHARS = [
    [/[ąęłśżźćń]/, "pl"],
    [/[ėųįūčšž]/, "lt"],
    [/[ãõ]/, "pt"],
    [/ñ/, "es"],
    [/ß/, "de"],
    [/[àâçèêîôûœ]/, "fr"],
  ];

  /** Schat de taal van een titel. Geeft "" als het niet duidelijk is (bijv. alleen een merknaam). */
  function detectLang(text) {
    if (!text) return "";
    const t = text.toLowerCase();
    const score = {};
    for (const [re, lang] of LANG_CHARS) if (re.test(t)) score[lang] = (score[lang] || 0) + 2;
    for (const w of t.split(/[^a-zà-ÿąćęłńśźżėųįūčšžãõñß]+/)) {
      if (w.length < 1) continue;
      for (const lang in LANG_SETS) if (LANG_SETS[lang].has(w)) score[lang] = (score[lang] || 0) + 1;
    }
    let best = "", bestScore = 0, second = 0;
    for (const [lang, sc] of Object.entries(score)) {
      if (sc > bestScore) { second = bestScore; best = lang; bestScore = sc; }
      else if (sc > second) second = sc;
    }
    return bestScore > second ? best : "";
  }

  /**
   * Taal van een artikel: uit de titel in de data, of anders uit de alt-tekst
   * van de foto op de pagina. Wordt één keer per artikel bepaald.
   * VINTED-AFHANKELIJK: alt-tekst van de foto bevat (een deel van) de titel.
   */
  function langOf(id, card) {
    if (langs.has(id)) return langs.get(id);
    let title = titles.get(id);
    if (!title && card) {
      const img = card.querySelector("img[alt]");
      title = img ? img.getAttribute("alt") : "";
    }
    if (!title) return "";
    const lang = detectLang(title);
    langs.set(id, lang);
    return lang;
  }

  const isForeign = (lang) => !!lang && lang !== "nl" && lang !== "en";

  /**
   * Volgorde van opzoeken (lager = eerder):
   *  0 Nederlandse titel, in beeld     1 Engelse/onduidelijke titel, in beeld
   *  2 Nederlandse titel, buiten beeld 3 Engelse/onduidelijke titel, buiten beeld
   *  4 titel in een andere taal (wordt voorlopig verborgen, dus als laatste)
   */
  function priorityFor(lang, visible) {
    if (isForeign(lang)) return 4;
    return (visible ? 0 : 2) + (lang === "nl" ? 0 : 1);
  }

  // ---------- weergave ----------
  // VINTED-AFHANKELIJK: elke artikelkaart heeft data-testid="product-item-id-<id>".
  // Werkt er ineens niets meer? Begin hier.
  const CARD_RE = /^product-item-id-(\d+)$/;

  /**
   * Het rastervak rond een kaart; dat element verbergen we, zodat er geen gat blijft.
   * VINTED-AFHANKELIJK: data-testid="grid-item" / class *feed-grid__item*.
   */
  function cellFor(card) {
    return (
      card.closest('[data-testid="grid-item"]') ||
      card.closest('[class*="feed-grid__item"]') ||
      card.closest('[class*="horizontal-scroll__item"]') ||
      card
    );
  }

  /**
   * Bepaalt de toestand van één artikel en vraagt zo nodig gegevens aan.
   *  - "pending": verkoper of land nog niet bekend (wordt opgehaald)
   *  - "in":      verkoper uit een gekozen land  → tonen
   *  - "out":     verkoper uit een ander land     → verbergen/dimmen
   *  - "unknown": opzoeken mislukt of land onbekend → tonen of verbergen (instelling)
   *  - "guess":   nog niet bekend, maar de titel is in een andere taal → voorlopig
   *               verbergen (alleen als langPrefilter aan staat)
   * Geen verkoper bekend na FALLBACK_DELAY? Dan de artikelpagina als uitwijk.
   * @returns {{s: string, c?: string, city?: string, lang?: string}}
   */
  function statusFor(itemId, prio, lang) {
    const st = lookupStatus(itemId, prio);
    if (st.s === "pending" && settings.langPrefilter && isForeign(lang)) return { s: "guess", lang };
    return st;
  }

  /** Status op basis van alleen de verkopersgegevens (zie statusFor). */
  function lookupStatus(itemId, prio) {
    const rec = items.get(itemId);
    if (!rec) {
      if (failedItems.has(itemId)) return { s: "unknown" };
      const seen = firstSeen.get(itemId) || Date.now();
      if (!firstSeen.has(itemId)) firstSeen.set(itemId, seen);
      if (Date.now() - seen > FALLBACK_DELAY) requestItemOwner(itemId, prio);
      else renderLater(FALLBACK_DELAY + 50);
      return { s: "pending" };
    }
    const u = users.get(rec.u);
    if (!u) {
      if (failedUsers.has(rec.u)) return { s: "unknown" };
      requestUser(rec.u, prio);
      return { s: "pending" };
    }
    if (u.c === "?") return { s: "unknown" };
    return { s: settings.countries.includes(u.c) ? "in" : "out", c: u.c, city: u.city };
  }

  /** Element waar het landlabel in komt (de foto); krijgt position:relative indien nodig. */
  function badgeHost(card) {
    const link = card.querySelector('[data-testid$="--overlay-link"]');
    const host = (link && link.parentElement) || card.querySelector(".vnbf-card__img") || card;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    return host;
  }

  /** Landlabel op de foto plaatsen of bijwerken ("NL · Utrecht", "FR", "…", "?"). */
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
    else if (st.s === "guess") text = `${st.lang.toUpperCase()}?`;
    else if (st.c) text = st.city && st.s === "in" ? `${st.c} · ${st.city}` : st.c;
    if (b.textContent !== text) b.textContent = text;
    b.dataset.state = st.s;
    b.title =
      st.s === "pending" ? "Land van verkoper wordt opgehaald…" :
      st.s === "unknown" ? "Land van verkoper onbekend" :
      st.s === "guess" ? "Titel lijkt niet Nederlands/Engels; voorlopig verborgen tot het land van de verkoper bekend is" :
      `Verkoper uit ${st.c}${st.city ? " (" + st.city + ")" : ""}`;
  }

  let counts = { in: 0, out: 0, pending: 0, unknown: 0, guess: 0 };

  /**
   * Hoofdlus. Draait na elke DOM-wijziging, scroll of nieuw gegeven (via renderSoon).
   *  1. nieuwe server-data uit de pagina lezen;
   *  2. instellingen als CSS-klassen op <html> zetten (het verbergen zelf doet content.css);
   *  3. per kaart (van Vinted én eigen aangevulde kaarten) de status bepalen,
   *     data-vnbf="<status>" op het rastervak zetten en het label bijwerken;
   *  4. wachtrij opschonen, statuslabel bijwerken en zo nodig aanvullen.
   * Moet goedkoop blijven: wordt vaak aangeroepen.
   */
  function render() {
    parseInlineScripts();
    const root = document.documentElement;
    root.classList.toggle("vnbf-off", !settings.enabled);
    root.classList.toggle("vnbf-mode-dim", settings.mode === "dim");
    root.classList.toggle("vnbf-reveal", reveal);
    root.classList.toggle("vnbf-hide-unknown", !settings.showUnknown);

    const c = { in: 0, out: 0, pending: 0, unknown: 0, guess: 0 };
    const vh = window.innerHeight || 800;
    const needed = new Set();
    syncContext();
    const cards = [];
    for (const card of document.querySelectorAll('[data-testid^="product-item-id-"]')) {
      const m = CARD_RE.exec(card.getAttribute("data-testid"));
      if (m) cards.push([card, +m[1]]);
    }
    for (const card of document.querySelectorAll(".vnbf-card")) cards.push([card, +card.dataset.vnbfItem]);
    for (const [card, id] of cards) {
      let prio = 4;
      const lang = settings.enabled ? langOf(id, card) : "";
      if (settings.enabled && !users.has(items.get(id)?.u)) {
        const r = card.getBoundingClientRect();
        const visible = r.height > 0 && r.bottom > -300 && r.top < vh + 600; // in of vlak bij beeld
        prio = priorityFor(lang, visible);
      }
      const st = settings.enabled ? statusFor(id, prio, lang) : { s: "in" };
      if (st.s === "pending" || st.s === "guess") {
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
    maybeAutoFill();
  }

  let laterTimer = null;
  /** Eén render over `ms` ms inplannen (bijv. als de uitwijk-wachttijd verstreken is). */
  function renderLater(ms) {
    if (laterTimer) return;
    laterTimer = setTimeout(() => { laterTimer = null; renderSoon(); }, ms);
  }

  /** Tekst alleen zetten als hij verandert; voorkomt onnodige DOM-mutaties (en dus render-lussen). */
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  let renderQueued = false;
  /** Render inplannen op het volgende animatieframe; meerdere aanroepen worden samengevoegd. */
  function renderSoon() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  // ---------- pagina aanvullen ----------
  // Als er na het filteren te weinig artikelen overblijven, halen we de
  // volgende pagina('s) van dezelfde zoekopdracht op en tonen we de artikelen
  // onder de bestaande resultaten. We gebruiken daarvoor Vinted's eigen
  // pagina-URL, zodat alle filters (merk, maat, prijs, sortering) meegaan.
  // ctx: zoekopdracht waar dit bij hoort · startPage/lastPage: eerste/laatst geladen pagina
  // autoPages: hoeveel automatisch geladen · seen: itemIds al in het blok · el: het blok zelf
  const fill = { ctx: "", startPage: 1, lastPage: 1, autoPages: 0, loading: false, ended: false, error: "", el: null, seen: new Set() };

  const isCatalog = () => location.pathname.startsWith("/catalog");

  /** Sleutel voor de huidige zoekopdracht (URL zonder `time`). Verandert die, dan begint aanvullen opnieuw. */
  function contextKey() {
    const u = new URL(location.href);
    u.searchParams.delete("time");
    return u.pathname + "?" + u.searchParams.toString();
  }

  /** URL van pagina n van de huidige zoekopdracht, met alle filters behouden. */
  function pageUrl(n) {
    const u = new URL(location.href);
    u.searchParams.delete("time");
    u.searchParams.set("page", String(n));
    return u.pathname + u.search;
  }

  /** Na navigatie naar een andere zoekopdracht/pagina: aangevulde blok weghalen en status resetten. */
  function syncContext() {
    const key = contextKey();
    if (key === fill.ctx) return;
    if (fill.el) fill.el.remove();
    const page = parseInt(new URL(location.href).searchParams.get("page") || "1", 10) || 1;
    Object.assign(fill, { ctx: key, startPage: page, lastPage: page, autoPages: 0, loading: false, ended: false, error: "", el: null, seen: new Set() });
    document.documentElement.classList.remove("vnbf-has-extra");
  }

  // React Server Components-stroom uit een opgehaalde HTML-pagina halen
  /**
   * Haalt de React Server Components-stroom uit opgehaalde HTML.
   * VINTED-AFHANKELIJK: Next.js App Router zet de stroom in stukken
   * `self.__next_f.push([1,"…"])`; elk stuk is een JSON-string die we decoderen
   * en aan elkaar plakken.
   */
  function decodeFlight(html) {
    let out = "";
    const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
    let m;
    while ((m = re.exec(html))) {
      try { out += JSON.parse(m[1]); } catch (_) {}
    }
    return out;
  }

  /**
   * Knipt het JSON-object dat op positie i begint uit tekst s, door accolades te tellen
   * (en accolades binnen strings te negeren). Geeft de substring terug, of null.
   */
  function objectAt(s, i) {
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < s.length; k++) {
      const ch = s[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return s.slice(i, k + 1);
    }
    return null;
  }

  /**
   * Alle artikelen uit een gedecodeerde stroom.
   * VINTED-AFHANKELIJK: objecten onder de sleutel "productItem" met o.a. id, title, url,
   * price, totalItemPrice, thumbnailUrl, itemBox.firstLine/secondLine en user.id.
   */
  function parseProductItems(flight) {
    const key = '"productItem":';
    const list = [];
    for (let p = flight.indexOf(key); p !== -1; p = flight.indexOf(key, p + key.length)) {
      const raw = objectAt(flight, p + key.length);
      if (!raw) continue;
      try {
        const o = JSON.parse(raw);
        if (typeof o.id === "number") list.push(o);
      } catch (_) {}
    }
    return list;
  }

  /** {amount: "17.00", currencyCode: "EUR"} → "€ 17,00". */
  function money(p) {
    if (!p || p.amount == null) return "";
    try {
      return new Intl.NumberFormat("nl-NL", { style: "currency", currency: p.currencyCode || "EUR" }).format(+p.amount);
    } catch (_) { return `€ ${p.amount}`; }
  }

  /** Klein hulpje om een element te maken; tekst altijd via textContent (veilig). */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /**
   * Eigen, eenvoudige kaart voor een aangevuld artikel (foto, merk, maat/staat, prijs).
   * Geen kopie van Vinted's kaart: die hangt aan React en zou niet werken.
   */
  function buildCard(it) {
    const card = el("div", "vnbf-card vnbf-cell");
    card.dataset.vnbfItem = String(it.id);
    const a = el("a", "vnbf-card__img");
    a.href = it.url || `/items/${it.id}`;
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = it.title || "";
    const thumb = it.thumbnailUrl || (it.thumbnailUrls && it.thumbnailUrls[0]) || (it.photos && it.photos[0] && it.photos[0].url);
    if (thumb) img.src = thumb;
    a.appendChild(img);
    card.appendChild(a);
    const body = el("a", "vnbf-card__body");
    body.href = a.href;
    const box = it.itemBox || {};
    const first = typeof box.firstLine === "string" && box.firstLine !== "$undefined" ? box.firstLine : it.title;
    body.append(el("div", "vnbf-card__brand", first || ""));
    if (typeof box.secondLine === "string" && box.secondLine !== "$undefined") body.append(el("div", "vnbf-card__sub", box.secondLine));
    body.append(el("div", "vnbf-card__price", money(it.price)));
    if (it.totalItemPrice) body.append(el("div", "vnbf-card__total", `${money(it.totalItemPrice)} incl.`));
    card.appendChild(body);
    return card;
  }

  /** Vinted's eigen raster met zoekresultaten (ouder van de rastervakken), of null. */
  function nativeGrid() {
    const first = document.querySelector('[data-testid^="product-item-id-"]');
    const item = first && (first.closest('[data-testid="grid-item"]') || first.closest('[class*="feed-grid__item"]'));
    return item ? item.parentElement : null;
  }

  /** Kolombreedte van Vinted's eigen raster overnemen, zodat aangevulde kaarten even breed zijn. */
  function matchColumns() {
    if (!fill.el) return;
    // Smalste zichtbare artikelkaart = één kolom (banners zijn breder)
    let min = Infinity;
    for (const card of document.querySelectorAll('[data-testid^="product-item-id-"]')) {
      if (!CARD_RE.test(card.getAttribute("data-testid"))) continue;
      const w = card.getBoundingClientRect().width;
      if (w > 60 && w < min) min = w;
    }
    if (min < Infinity) fill.el.style.setProperty("--vnbf-col", `${Math.floor(min) - 2}px`);
  }

  /** Maakt het blok voor aangevulde artikelen direct onder Vinted's raster (één keer). */
  function ensureBlock() {
    if (fill.el && fill.el.isConnected) { matchColumns(); return fill.el; }
    const grid = nativeGrid();
    if (!grid) return null;
    const sec = el("section", "vnbf-extra");
    sec.append(el("div", "vnbf-extra__head"), el("div", "vnbf-extra__grid"), el("div", "vnbf-extra__foot"));
    grid.insertAdjacentElement("afterend", sec);
    fill.el = sec;
    matchColumns();
    return sec;
  }

  /** Kop en voet van het aangevulde blok bijwerken: 'Meer laden', 'Ga naar pagina N', status. */
  function updateBlock() {
    const sec = fill.el;
    if (!sec) return;
    const label = settings.countries.join("/") || "gekozen landen";
    const head = sec.querySelector(".vnbf-extra__head");
    const range = fill.lastPage > fill.startPage + 1 ? `pagina ${fill.startPage + 1}–${fill.lastPage}` : `pagina ${fill.startPage + 1}`;
    setText(head, fill.lastPage > fill.startPage ? `Aangevuld uit ${range} · alleen ${label}` : "");
    const foot = sec.querySelector(".vnbf-extra__foot");
    foot.textContent = "";
    if (fill.startPage > 1) {
      const prev = el("a", "vnbf-extra__link", "← Vorige pagina");
      prev.href = pageUrl(fill.startPage - 1);
      foot.append(prev);
    }
    if (fill.loading) foot.append(el("span", "vnbf-extra__status", `Pagina ${fill.lastPage + 1} laden…`));
    else if (fill.error) foot.append(el("span", "vnbf-extra__status", fill.error));
    if (!fill.ended) {
      const more = el("button", "vnbf-extra__more", `Meer laden (pagina ${fill.lastPage + 1})`);
      more.type = "button";
      more.disabled = fill.loading;
      more.addEventListener("click", () => loadNextPage());
      const next = el("a", "vnbf-extra__link", `Ga naar pagina ${fill.lastPage + 1} →`);
      next.href = pageUrl(fill.lastPage + 1);
      foot.append(more, next);
    } else {
      foot.append(el("span", "vnbf-extra__status", "Geen verdere resultaten."));
    }
    document.documentElement.classList.toggle("vnbf-has-extra", fill.lastPage > fill.startPage);
  }

  /**
   * Haalt de volgende pagina van de huidige zoekopdracht op en voegt de artikelen toe.
   * Werkt via Vinted's eigen pagina-URL (?page=N), zodat alle filters meegaan.
   * Artikelen die al op het scherm staan worden overgeslagen (Vinted-pagina's overlappen).
   * Navigeer je ondertussen weg, dan wordt het resultaat weggegooid (ctx-controle).
   */
  async function loadNextPage() {
    if (fill.loading || fill.ended || !isCatalog()) return;
    const sec = ensureBlock();
    if (!sec) return;
    const ctx = fill.ctx;
    const page = fill.lastPage + 1;
    fill.loading = true;
    fill.error = "";
    updateBlock();
    try {
      const res = await pageFetch(location.origin + pageUrl(page), { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const list = parseProductItems(decodeFlight(await res.text()));
      if (ctx !== fill.ctx) return; // intussen naar een andere zoekopdracht gegaan
      const native = new Set(
        [...document.querySelectorAll('[data-testid^="product-item-id-"]')]
          .map((c) => CARD_RE.exec(c.getAttribute("data-testid")))
          .filter(Boolean)
          .map((m) => +m[1])
      );
      const pairs = [];
      const grid = sec.querySelector(".vnbf-extra__grid");
      let added = 0;
      for (const it of list) {
        if (native.has(it.id) || fill.seen.has(it.id)) continue;
        fill.seen.add(it.id);
        if (it.user && typeof it.user.id === "number") pairs.push([it.id, it.user.id, it.title || ""]);
        grid.appendChild(buildCard(it));
        added++;
      }
      addPairs(pairs);
      fill.lastPage = page;
      if (!list.length) fill.ended = true;
    } catch (e) {
      if (ctx === fill.ctx) fill.error = "Laden mislukt — probeer het later opnieuw.";
    } finally {
      if (ctx === fill.ctx) {
        fill.loading = false;
        updateBlock();
        renderSoon();
      }
    }
  }

  /**
   * Na elke render: moet er automatisch aangevuld worden? Alleen als
   *  - filter aan, modus 'verbergen' en we op een /catalog-pagina zitten;
   *  - alle artikelen bekend zijn (geen 'pending'), anders tellen we verkeerd;
   *  - er minder dan AUTOFILL_TARGET zichtbaar zijn en we nog geen AUTOFILL_MAX_PAGES deden.
   * Het blok met 'Meer laden' verschijnt zodra er iets verborgen is.
   */
  function maybeAutoFill() {
    if (fill.el && !fill.el.isConnected) fill.el = null;
    const active = settings.enabled && settings.mode === "hide" && isCatalog();
    if (!active) {
      if (fill.el) fill.el.hidden = true;
      document.documentElement.classList.remove("vnbf-has-extra");
      return;
    }
    if (fill.el) {
      fill.el.hidden = false;
      document.documentElement.classList.toggle("vnbf-has-extra", fill.lastPage > fill.startPage);
    }
    const visible = counts.in + (settings.showUnknown ? counts.unknown : 0);
    const total = visible + counts.out + counts.pending;
    if (!total || fill.loading || fill.ended) return;
    if (!fill.el && counts.out > 0 && ensureBlock()) updateBlock(); // knop 'Meer laden' zodra er iets verborgen is
    if (
      settings.autoFill &&
      counts.pending === 0 &&
      visible < AUTOFILL_TARGET &&
      fill.autoPages < AUTOFILL_MAX_PAGES
    ) {
      fill.autoPages++;
      loadNextPage();
    }
  }

  // ---------- statuslabel ----------
  let pill = null;
  /** Statuslabel linksonder maken/bijwerken: aan/uit, tellingen, 'toon'-knop. */
  function updatePill() {
    const total = counts.in + counts.out + counts.pending + counts.unknown + counts.guess;
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
      const hidden = counts.out + counts.guess + hiddenUnknown;
      parts.push(`${hidden} ${settings.mode === "dim" ? "gedimd" : "verborgen"}${counts.guess ? ` (${counts.guess} voorlopig, op taal)` : ""}`);
      if (counts.pending) {
        const mins = Math.ceil(limiter.queue.length / RATE);
        parts.push(`${counts.pending} laden…${mins > 1 ? ` (~${mins} min)` : ""}`);
      }
    } else {
      parts.push("filter staat uit");
    }
    setText(pill.querySelector(".vnbf-pill__text"), parts.join(" · "));
    const rv = pill.querySelector(".vnbf-pill__reveal");
    rv.hidden = !settings.enabled || settings.mode === "dim" || counts.out + counts.guess + (settings.showUnknown ? 0 : counts.unknown) === 0;
    setText(rv, reveal ? "verberg" : "toon");
  }

  // ---------- opstarten ----------
  // Instellingen gewijzigd in het pop-upmenu → direct toepassen, zonder herladen.
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

  // Wijzigingen in onze eigen elementen (labels, statuslabel, aangevuld blok) negeren,
  // anders zou elke render een nieuwe render veroorzaken.
  const ours = (n) =>
    n.nodeType === 1
      ? n.classList.contains("vnbf-badge") || !!n.closest(".vnbf-pill, .vnbf-extra")
      : !!(n.parentElement && n.parentElement.closest(".vnbf-pill, .vnbf-badge, .vnbf-extra"));
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (ours(m.target)) continue;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (nodes.length && nodes.every(ours)) continue;
      renderSoon();
      return;
    }
  });

  // Start: eerst instellingen en cache, dan meekijken met de pagina.
  // Draait al bij document_start, dus vóór Vinted's eigen scripts klaar zijn.
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
