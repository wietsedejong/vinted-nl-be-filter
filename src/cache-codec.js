// Verkoperscache: opslagformaat (gedeeld door content.js en de beheerpagina).
//
// De cache is een lokale database: verkopers-ID → land, woonplaats, zakelijk, datum.
// Zowel Nederlandse/Belgische als buitenlandse verkopers worden bewaard: elke bekende
// verkoper hoeft niet opnieuw bij Vinted te worden opgezocht.
//
// Opslag in browser.storage.local, verdeeld over VNBF_SHARDS sleutels ("vnbfU:0" …
// "vnbfU:127"), zodat bij een wijziging alleen het betreffende deel opnieuw wordt
// weggeschreven in plaats van de hele database.
//
// Per verkoper: [land, woonplaats, zakelijk (0/1), dag van controle]
//   bijv. 43723686: ["NL", "Utrecht", 0, 20388]
// Zo'n regel is ±30 bytes; 200.000 verkopers ≈ 6 MB.

/* exported VNBF_CACHE */
var VNBF_CACHE = (() => {
  const SHARDS = 128;
  const PREFIX = "vnbfU:";
  const DAY = 864e5;

  const shardKey = (id) => PREFIX + (id % SHARDS);
  const isShardKey = (k) => typeof k === "string" && k.startsWith(PREFIX);

  /** {c, city, b, t} → compacte array */
  const encode = (u) => [u.c, u.city || "", u.b ? 1 : 0, Math.floor(u.t / DAY)];
  /** compacte array → {c, city, b, t} */
  const decode = (a) => ({ c: a[0], city: a[1] || "", b: !!a[2], t: a[3] * DAY });

  /** Alle verkopers uit storage.local laden (incl. omzetten van het oude formaat). */
  async function loadAll(storage) {
    const all = await storage.get(null);
    const users = new Map();
    for (const [k, shard] of Object.entries(all)) {
      if (!isShardKey(k) || !shard) continue;
      for (const [id, a] of Object.entries(shard)) users.set(+id, decode(a));
    }
    // Oud formaat (tot v0.6): één grote sleutel "vnbfUsers" met objecten.
    if (all.vnbfUsers) {
      for (const [id, v] of Object.entries(all.vnbfUsers)) {
        if (v && "b" in v && !users.has(+id)) users.set(+id, { c: v.c, city: v.city || "", b: !!v.b, t: v.t });
      }
    }
    return { users, legacy: !!all.vnbfUsers };
  }

  /** Alleen de opgegeven delen (shards) wegschrijven. */
  async function saveShards(storage, users, shardIds) {
    const out = {};
    for (const s of shardIds) out[PREFIX + s] = {};
    for (const [id, u] of users) {
      const key = shardKey(id);
      if (key in out) out[key][id] = encode(u);
    }
    await storage.set(out);
  }

  /** Volledige database wegschrijven (bijv. na import of opschonen). */
  async function saveAll(storage, users) {
    await saveShards(storage, users, [...Array(SHARDS).keys()]);
    await storage.remove("vnbfUsers"); // oud formaat opruimen
  }

  /** Alle cache-sleutels verwijderen. */
  async function clearAll(storage) {
    const keys = [...Array(SHARDS).keys()].map((s) => PREFIX + s);
    await storage.remove([...keys, "vnbfUsers", "vnbfItems"]);
  }

  /** Database als exportbestand (JSON). */
  function toExport(users) {
    const data = {};
    for (const [id, u] of users) data[id] = encode(u);
    return { format: "vinted-nl-be-filter/verkopers", version: 1, exported: new Date().toISOString(), count: users.size, users: data };
  }

  /** Exportbestand samenvoegen met bestaande database; per verkoper wint de nieuwste controle. */
  function mergeImport(users, json) {
    if (!json || json.format !== "vinted-nl-be-filter/verkopers" || typeof json.users !== "object") {
      throw new Error("Dit is geen exportbestand van de Vinted NL/BE-filter.");
    }
    let added = 0, updated = 0;
    for (const [id, a] of Object.entries(json.users)) {
      if (!Array.isArray(a) || typeof a[0] !== "string") continue;
      const u = decode(a);
      const cur = users.get(+id);
      if (!cur) { users.set(+id, u); added++; }
      else if (u.t > cur.t) { users.set(+id, u); updated++; }
    }
    return { added, updated };
  }

  return { SHARDS, PREFIX, DAY, shardKey, isShardKey, encode, decode, loadAll, saveShards, saveAll, clearAll, toExport, mergeImport };
})();
