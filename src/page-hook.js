// Draait in de pagina zelf (MAIN world). Luistert mee met de API-antwoorden die
// Vinted zelf ophaalt (zoekresultaten, volgende pagina's, feeds) en geeft per
// artikel het verkopers-ID door aan content.js. Er worden hier geen extra
// verzoeken gedaan.
(() => {
  if (window.__vnbfHooked) return;
  window.__vnbfHooked = true;

  const MSG = "vnbf:pairs";
  const MAX_LEN = 5_000_000;

  /** Koppelingen doorgeven aan content.js (die draait in een afgeschermde 'wereld'). */
  function post(pairs) {
    if (pairs.length) window.postMessage({ type: MSG, pairs }, location.origin);
  }

  // Zoek in willekeurige JSON naar objecten die op een artikel lijken:
  // { id: <nummer>, user: { id: <nummer> }, title|url }
  // VINTED-AFHANKELIJK: zo zien artikelen eruit in /svc-catalogue/items en feeds.
  // Bewust ruim gehouden, zodat het ook werkt als Vinted velden toevoegt.
  function walk(node, pairs, depth = 0) {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, pairs, depth + 1);
      return;
    }
    const u = node.user;
    if (
      typeof node.id === "number" &&
      u && typeof u === "object" && typeof u.id === "number" &&
      ("title" in node || "url" in node)
    ) {
      pairs.push([node.id, u.id]);
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === "object") walk(v, pairs, depth + 1);
    }
  }

  // React Server Components-tekst (bij navigatie binnen de site)
  // VINTED-AFHANKELIJK: "productItem":{"id":…} met daarin "user":{"id":…}.
  function fromRscText(text) {
    const pairs = [];
    const t = text.replace(/\\"/g, '"');
    const parts = t.split('"productItem":{"id":');
    for (let i = 1; i < parts.length; i++) {
      const id = parseInt(parts[i], 10);
      const m = parts[i].match(/"user":\{"id":(\d+)/);
      if (id && m) pairs.push([id, parseInt(m[1], 10)]);
    }
    return pairs;
  }

  /** Eén API-antwoord verwerken: JSON doorzoeken, of anders als RSC-tekst lezen. */
  function handle(url, text) {
    try {
      if (!text || text.length > MAX_LEN || text.indexOf('"user"') === -1 && text.indexOf('\\"user\\"') === -1) return;
      const trimmed = text.trimStart();
      if (trimmed[0] === "{" || trimmed[0] === "[") {
        const pairs = [];
        walk(JSON.parse(trimmed), pairs);
        post(pairs);
      } else {
        post(fromRscText(text));
      }
    } catch (_) { /* geen JSON of onbekend formaat: negeren */ }
  }

  /** Alleen antwoorden van vinted.nl/.be (incl. api.vinted.nl), geen afbeeldingen/scripts. */
  function interesting(url) {
    try {
      const u = new URL(url, location.href);
      return /(^|\.)vinted\.(nl|be)$/.test(u.hostname) && !/\.(js|css|png|jpe?g|webp|svg|woff2?)$/.test(u.pathname);
    } catch (_) { return false; }
  }

  // fetch vervangen door een versie die meeleest. Het antwoord wordt gekloond,
  // zodat Vinted zelf het origineel ongewijzigd krijgt.
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === "string" ? req : (req && req.url) || String(req);
      if (interesting(url)) {
        p.then((res) => {
          const ct = res.headers.get("content-type") || "";
          if (/json|x-component|text\/plain/.test(ct)) {
            res.clone().text().then((t) => handle(url, t)).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return p;
  };

  // Hetzelfde voor XMLHttpRequest, voor het geval Vinted (een deel van) de data zo ophaalt.
  const XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (interesting(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") handle(url, this.responseText);
            else if (this.responseType === "json" && this.response) {
              const pairs = [];
              walk(this.response, pairs);
              post(pairs);
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
    return XO.call(this, method, url, ...rest);
  };
})();
