# Vinted NL/BE-filter

> Vinted heeft een filter voor 47 tinten beige, maar niet voor "die trui ligt gewoon in Zwolle".
> Je zoekt een spijkerbroek en krijgt half Europa: een jeans uit Lyon, een jas uit Bari, en een vest waarvan de verzendkosten hoger zijn dan het vest zelf.
> Deze extensie doet wat Vinted zelf blijkbaar te ingewikkeld vindt: alleen laten zien wat dichtbij is.

Browserextensie voor Firefox en Chrome die op **vinted.nl** alleen artikelen toont van verkopers uit **Nederland en België**. Andere landen zijn instelbaar.

---

## ⚠️ Lees dit eerst

**Deze extensie is voor mensen die weten wat ze doen.**

- Er is **geen ondersteuning**. Geen helpdesk, geen mail, geen "kun je even kijken?". Werkt het niet, dan zoek je het zelf uit.
- Je moet zelf een extensie handmatig kunnen laden, een foutmelding in de browserconsole kunnen lezen en zo nodig een stukje JavaScript kunnen aanpassen.
- Vinted verandert regelmatig iets aan de site. Dan gaat dit stuk. De vraag is niet óf, maar wannéér.
- Issues en pull requests mag je openen, maar reken nergens op. Een werkende fix in een pull request maakt de meeste kans.
- Gebruik is op eigen risico. Zie [Gebruiksvoorwaarden](#gebruiksvoorwaarden).

Herken je jezelf niet in het lijstje hierboven? Dan is dit waarschijnlijk niets voor jou.

---

## Wat het doet

- **Filtert op land van de verkoper.** Standaard NL en BE. Andere landen vink je aan in het menu.
- **Verbergt of dimt** artikelen van buiten die landen.
- **Eigen resultatenlijst.** Vinted toont 96 artikelen per pagina, van alle landen door elkaar; na filteren blijven er soms maar een paar over. Daarom vervangt de extensie Vinted's raster door een eigen lijst die zichzelf vult: ze doorzoekt Vinted-pagina 1, 2, 3 … van dezelfde zoekopdracht (met alle filters) tot er 48 NL/BE-artikelen staan. Scroll je naar beneden of klik je **Meer laden**, dan zoekt ze verder.
- **Snel voorfilteren op taal.** Opzoeken gaat in deze volgorde: eerst artikelen met een Nederlandse titel, dan Engelse of onduidelijke titels, en als laatste titels in een andere taal. Artikelen met een duidelijk Franse, Duitse, Spaanse enz. titel worden meteen voorlopig verborgen (label `FR?`), tot het land van de verkoper bekend is. Is de verkoper toch Belg of Nederlander, dan verschijnt het artikel alsnog. Dit staat aan; uitzetten kan in het menu.
- **Verschijnt pas als het zeker is.** Artikelen waarvan het land nog niet bekend is, blijven verborgen en verschijnen zodra de verkoper is gecontroleerd. Artikelen met een onbekend land blijven weg. Beide is uit te zetten in het menu.
- **Zakelijke verkopers (Vinted Pro) eruit.** Die herkent de extensie direct uit de zoekresultaten, dus zonder extra opzoekwerk.
- **Landlabel op elke foto**, bijvoorbeeld `NL · Utrecht`. Zo zie je ook meteen of ophalen kan.
- **Statuslabel linksonder.** Toont hoeveel artikelen getoond, verborgen en nog aan het laden zijn. Je zet het filter er aan en uit, en met **toon** zie je even wat er verborgen is.
- **Cache.** Een verkoper die al eens is opgezocht, is de volgende keer direct bekend.

## Installeren

### Firefox (versie 128 of nieuwer)

**Tijdelijk**

Ga naar `about:debugging#/runtime/this-firefox`, klik op **Tijdelijke add-on laden…** en kies `manifest.json`. De add-on verdwijnt als Firefox herstart.

**Permanent**

Firefox installeert alleen ondertekende extensies. Ondertekenen kan gratis, als 'unlisted' (niet zichtbaar in de winkel):

```bash
# API-sleutels: https://addons.mozilla.org/developers/addon/api/key/
npx web-ext sign --channel=unlisted --api-key=JOUW_KEY --api-secret=JOUW_SECRET
```

Open daarna het `.xpi`-bestand uit `web-ext-artifacts/` in Firefox.

### Chrome / Chromium / Edge / Brave

Ga naar `chrome://extensions`, zet **Ontwikkelaarsmodus** aan, klik op **Uitgepakte extensie laden** en kies deze map.

## Hoe het werkt

Bij zoekresultaten van Vinted zit wel het ID van de verkoper, maar niet zijn land. De extensie zoekt dat zo op:

1. **Verkoper per artikel.** Uit de zoekresultaten die al in de pagina zitten (Next.js-serverrender). Bij doorbladeren leest `page-hook.js` mee met de API-antwoorden die Vinted zelf ophaalt. Dit kost geen extra verzoeken.
2. **Land per verkoper.** Via `GET /api/v2/users/<id>`, hetzelfde profiel dat je ziet als je op een verkoper klikt. Het antwoord gaat 60 dagen de cache in.
3. **Uitwijk.** Vindt de extensie bij een artikel geen verkoper, dan haalt ze de artikelpagina op en zoekt het ID daar.
4. **Aanvullen.** De extensie haalt de HTML op van `?page=N+1`, Vinted's eigen pagina-URL, zodat alle filters meegaan. Daaruit leest ze de artikelen en toont ze die als eigen kaarten.

Alles loopt via je eigen browsersessie op vinted.nl. Er gaan geen gegevens naar andere servers.

## Beperkingen

- **Traag bij nieuwe verkopers.** Vinted staat ongeveer **30 profielopvragingen per minuut** toe. Daarboven volgt een `429` met `Retry-After: 60`. De extensie houdt het bij 24 per minuut, zodat je zelf normaal kunt blijven browsen. Een volle pagina met alleen onbekende verkopers duurt daardoor 3 à 4 minuten. Wat in beeld is, komt eerst aan de beurt. Door de cache gaat het steeds sneller.
- **De eigen lijst zoekt met beleid.** Ze haalt pas een volgende Vinted-pagina op als de vorige grotendeels gecontroleerd is, en per stap hooguit 6 pagina's. Bij een zeldzame zoekopdracht klik je daarna zelf op **Meer laden**.
- **Eenvoudigere kaarten.** De lijst bestaat uit eigen, kale kaarten. Favorieten en snelle acties werken daar niet; klik door naar het artikel. Wil je Vinted's eigen weergave terug, zet dan **Eigen resultatenlijst** uit in het menu.
- **Alleen in de browser.** In de Vinted-app werkt dit niet. Op Android kan het wel met Firefox.

## Als het stuk is

Je staat er alleen voor (zie hierboven). Elke plek in de code die afhangt van hoe Vinted's site in elkaar zit, is gemarkeerd met `VINTED-AFHANKELIJK`:

```bash
grep -rn "VINTED-AFHANKELIJK" src/
```

Daar begin je. Per symptoom:

| Symptoom | Waarschijnlijke oorzaak | Waar kijken |
|---|---|---|
| Geen labels, niets gebeurt | Vinted heeft de kaartstructuur veranderd | `CARD_RE` / `data-testid="product-item-id-…"` in `content.js` |
| Labels blijven op `…` staan | Koppeling artikel → verkoper werkt niet meer | `parseInlineScripts()` en `page-hook.js` |
| Alles wordt `?` | `/api/v2/users/<id>` is veranderd of geblokkeerd | `fetchUser()` |
| Constant `429` in de console | Vinted heeft de limiet verlaagd | `RATE` in `content.js` |
| Eigen lijst blijft leeg / **Meer laden** geeft niets | De Next.js-stroom is anders opgebouwd | `decodeFlight()` / `parseProductItems()` |

## Bestanden

| Bestand | Rol |
|---|---|
| `manifest.json` | Manifest V3, Firefox en Chrome |
| `src/page-hook.js` | Draait in de pagina en leest mee met Vinted's API-antwoorden |
| `src/content.js` | Opzoeken, filteren, labels, aanvullen, statuslabel |
| `src/content.css` | Stijlen |
| `src/popup.*` | Instellingenmenu |

## Gebruiksvoorwaarden

Dit is een onofficieel hulpmiddel, zonder enige band met Vinted. De extensie gebruikt Vinted's interne, niet-gedocumenteerde endpoints. Ze doet alleen opvragingen die je zelf ook zou doen door op een verkoper te klikken, en ze blijft onder het tempo dat Vinted toestaat. Toch kan het tegen Vinted's voorwaarden ingaan. Gebruik is volledig op eigen risico.

## Licentie

MIT. Doe ermee wat je wilt, maar verwacht niets.
