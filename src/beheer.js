// Beheerpagina van de verkoperscache: overzicht, exporteren, importeren, wissen.
// Opent via het pop-upmenu ("Cache beheren…") of via de extensie-instellingen.
// Gebruikt het opslagformaat uit cache-codec.js.
const api = globalThis.browser ?? globalThis.chrome;
const store = api.storage.local;
const $ = (s) => document.querySelector(s);
const nf = new Intl.NumberFormat("nl-NL");

/** Tellingen en datums bijwerken. */
async function refresh() {
  const { users } = await VNBF_CACHE.loadAll(store);
  let nl = 0, be = 0, pro = 0, oldest = Infinity, newest = 0;
  for (const u of users.values()) {
    if (u.c === "NL") nl++;
    else if (u.c === "BE") be++;
    if (u.b) pro++;
    if (u.t < oldest) oldest = u.t;
    if (u.t > newest) newest = u.t;
  }
  $("#total").textContent = nf.format(users.size);
  $("#nl").textContent = nf.format(nl);
  $("#be").textContent = nf.format(be);
  $("#other").textContent = nf.format(users.size - nl - be);
  $("#pro").textContent = nf.format(pro);
  const df = new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium" });
  const bytes = JSON.stringify(VNBF_CACHE.toExport(users).users).length;
  $("#meta").textContent = users.size
    ? `Gecontroleerd tussen ${df.format(oldest)} en ${df.format(newest)} · ongeveer ${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`
    : "De cache is nog leeg. Zoek iets op vinted.nl en hij vult zich vanzelf.";
  return users;
}

function say(text, isError = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("status--error", isError);
}

$("#export").addEventListener("click", async () => {
  const { users } = await VNBF_CACHE.loadAll(store);
  const blob = new Blob([JSON.stringify(VNBF_CACHE.toExport(users))], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `vinted-verkopers-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  say(`${nf.format(users.size)} verkopers geëxporteerd.`);
});

$("#import").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    const { users } = await VNBF_CACHE.loadAll(store);
    const { added, updated } = VNBF_CACHE.mergeImport(users, json);
    await VNBF_CACHE.saveAll(store, users);
    say(`Geïmporteerd: ${nf.format(added)} nieuwe verkopers, ${nf.format(updated)} bijgewerkt.`);
    refresh();
  } catch (err) {
    say(`Importeren mislukt: ${err.message}`, true);
  }
});

$("#clear").addEventListener("click", async () => {
  if (!confirm("Weet je zeker dat je de hele verkoperscache wilt wissen?")) return;
  await VNBF_CACHE.clearAll(store);
  say("Cache gewist.");
  refresh();
});

refresh();
