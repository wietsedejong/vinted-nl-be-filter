# Vinted NL/BE-filter

Browserextensie (Firefox en Chrome) die op **vinted.nl** alleen artikelen laat zien van verkopers uit **Nederland en België**. Welke landen meetellen stel je zelf in.

Sinds Vinted één Europese marktplaats is, staan er in je zoekresultaten veel artikelen uit Frankrijk, Spanje, Italië enz., met hogere verzendkosten en langere levertijden. Vinted heeft zelf geen filter op het land van de verkoper. Deze extensie voegt dat toe.

## Wat je krijgt

- **Filter op land van de verkoper.** Standaard NL en BE. Andere landen vink je aan in het pop-upmenu.
- **Verbergen of dimmen.** Artikelen van buiten de gekozen landen verdwijnen, of blijven grijs zichtbaar.
- **Landlabel op elke foto**, bijvoorbeeld `NL · Utrecht` of `BE · Gent`. Zo zie je ook of ophalen een optie is.
- **Statuslabel linksonder.** Toont hoeveel artikelen getoond, verborgen en nog aan het laden zijn. Met één klik zet je het filter uit, met **toon** zie je tijdelijk wat er verborgen is.
- **Cache.** Een verkoper die al eens is opgezocht, is de volgende keer direct bekend.

## Installeren

### Firefox

**Tijdelijk (om te testen)**

1. Download of clone deze repo.
2. Ga naar `about:debugging#/runtime/this-firefox`.
3. Klik op **Tijdelijke add-on laden…** en kies `manifest.json`.

Een tijdelijke add-on verdwijnt als Firefox herstart.

**Permanent**

Firefox installeert alleen ondertekende extensies. Ondertekenen is gratis en kan als 'unlisted': de extensie verschijnt dan niet publiek in de winkel.

1. Maak API-sleutels aan op <https://addons.mozilla.org/developers/addon/api/key/>.
2. Onderteken de extensie:

   ```bash
   npx web-ext sign --channel=unlisted --api-key=... --api-secret=...
   ```

3. Open het `.xpi`-bestand uit `web-ext-artifacts/` in Firefox.

### Chrome / Chromium / Edge / Brave

1. Download of clone deze repo.
2. Ga naar `chrome://extensions` en zet **Ontwikkelaarsmodus** aan.
3. Klik op **Uitgepakte extensie laden** en kies de map van deze repo.

## Hoe het werkt

Bij zoekresultaten van Vinted zit wel het ID van de verkoper, maar niet zijn land. De extensie zoekt dat in drie stappen op:

1. **Verkoper per artikel.** De extensie leest de zoekresultaten die Vinted al in de pagina meestuurt. Bij doorbladeren leest `page-hook.js` mee met de API-antwoorden die Vinted zelf ophaalt. Dit kost geen extra verzoeken.
2. **Land per verkoper.** Via `/api/v2/users/<id>`, het profiel dat Vinted ook toont als je op een verkoper klikt. Het antwoord wordt 60 dagen bewaard.
3. **Uitwijk.** Vindt de extensie bij een artikel geen verkoper, dan haalt ze na 2,5 seconden de artikelpagina op en zoekt het ID daar.

Alle verzoeken lopen via je eigen browsersessie op vinted.nl. Er gaan geen gegevens naar andere servers.

## Beperkingen

- **Het eerste bezoek is traag.** Vinted staat ongeveer 30 profielopvragingen per minuut toe. De extensie houdt het bij 24, zodat je zelf normaal kunt blijven browsen. Een volle pagina van 96 artikelen met allemaal nieuwe verkopers duurt daardoor 3 à 4 minuten. Artikelen in beeld komen als eerste aan de beurt. Dankzij de cache gaat het bij volgende zoekopdrachten steeds sneller.
- **Pagina's worden korter.** Vinted toont 96 artikelen per pagina. Wat verborgen wordt, vult de extensie niet aan, dus je ziet per pagina minder artikelen.
- **De extensie kan stukgaan als Vinted de site verandert.** Ze leunt op de interne structuur van de site en op niet-officiële API's. Werkt ze ineens niet meer, kijk dan eerst of er een nieuwe versie is.
- **Gebruiksvoorwaarden.** De extensie doet alleen opvragingen die je ook zelf zou doen als je op een verkoper klikt, en ze houdt zich aan Vinted's tempo. Toch gebruikt ze Vinted's interne, niet-officiële API's. Gebruik is op eigen risico.
- **Alleen in de browser.** In de Vinted-app op je telefoon werkt dit niet. Op Android kan het wel met Firefox.

## Bestanden

| Bestand | Rol |
|---|---|
| `manifest.json` | Extensie-manifest (MV3, Firefox en Chrome) |
| `src/page-hook.js` | Draait in de pagina en leest mee met de API-antwoorden van Vinted (artikel → verkoper) |
| `src/content.js` | Zoekt het land op, verbergt of dimt artikelen, toont labels en het statuslabel |
| `src/content.css` | Stijlen voor labels, verbergen en dimmen |
| `src/popup.*` | Instellingenmenu |

## Licentie

MIT
