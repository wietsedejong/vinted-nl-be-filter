// Instellingenmenu (klik op het extensie-icoon).
// Alles wordt opgeslagen in browser.storage.sync; content.js luistert mee en past
// wijzigingen direct toe op open Vinted-tabbladen.
const api = globalThis.browser ?? globalThis.chrome;

// Moet gelijk blijven aan DEFAULTS in content.js.
const DEFAULTS = {
  enabled: true,
  countries: ["NL", "BE"],
  mode: "hide",
  showUnknown: false,
  hidePending: true,
  hideBusiness: true,
  badges: true,
  showPill: true,
  ownList: true,
  langPrefilter: true,
  newTab: true,
};

// Landen waar Vinted actief is (selectie; NL/BE bovenaan)
const COUNTRIES = [
  ["NL", "Nederland"], ["BE", "België"], ["LU", "Luxemburg"], ["DE", "Duitsland"],
  ["FR", "Frankrijk"], ["AT", "Oostenrijk"], ["ES", "Spanje"], ["IT", "Italië"],
  ["PT", "Portugal"], ["PL", "Polen"], ["CZ", "Tsjechië"], ["SK", "Slowakije"],
  ["LT", "Litouwen"], ["IE", "Ierland"], ["DK", "Denemarken"], ["SE", "Zweden"],
  ["FI", "Finland"], ["HU", "Hongarije"], ["RO", "Roemenië"], ["HR", "Kroatië"],
  ["GR", "Griekenland"], ["SI", "Slovenië"], ["GB", "VK"],
];

const $ = (s) => document.querySelector(s);

/** Formulier vullen met de huidige instellingen en wijzigingen direct opslaan. */
async function init() {
  const s = { ...DEFAULTS, ...(await api.storage.sync.get(DEFAULTS)) };

  $("#enabled").checked = s.enabled;
  $("#showUnknown").checked = s.showUnknown;
  $("#badges").checked = s.badges;
  $("#showPill").checked = s.showPill;
  $("#ownList").checked = s.ownList;
  $("#langPrefilter").checked = s.langPrefilter;
  $("#hidePending").checked = s.hidePending;
  $("#hideBusiness").checked = s.hideBusiness;
  $("#newTab").checked = s.newTab;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;

  const box = $("#countries");
  for (const [code, name] of COUNTRIES) {
    const label = document.createElement("label");
    label.className = "chip";
    label.title = name;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = code;
    input.checked = s.countries.includes(code);
    const span = document.createElement("span");
    span.textContent = code;
    label.append(input, span);
    box.appendChild(label);
  }

  for (const id of ["enabled", "showUnknown", "badges", "showPill", "ownList", "langPrefilter", "hidePending", "hideBusiness", "newTab"]) {
    $("#" + id).addEventListener("change", (e) => api.storage.sync.set({ [id]: e.target.checked }));
  }
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener("change", () => api.storage.sync.set({ mode: r.value }));
  }
  box.addEventListener("change", () => {
    const countries = [...box.querySelectorAll("input:checked")].map((i) => i.value);
    api.storage.sync.set({ countries });
  });

  await showCacheInfo();
  $("#manage").addEventListener("click", () => {
    api.runtime.openOptionsPage();
    window.close();
  });
}

/** Toont hoeveel verkopers er in de cache staan (zie cache-codec.js). */
async function showCacheInfo() {
  const { users } = await VNBF_CACHE.loadAll(api.storage.local);
  const n = users.size;
  $("#cacheInfo").textContent = `${new Intl.NumberFormat("nl-NL").format(n)} verkoper${n === 1 ? "" : "s"} bekend`;
}

init();
