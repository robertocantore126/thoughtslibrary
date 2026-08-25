# R-node → Thoughtslibrary Functional Parity Audit

**Data audit:** 2026-08-25
**Reference implementation:** `C:\Users\39389\Documents\XuanZhi9\r-node`
**Compared implementation:** `C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary`
**Deliverable scope:** audit document only. No application source, tests, or configuration files were changed.

## Audit conventions

R-node is treated as the behavioral reference. The comparison is made at the level of what a user can do and what result the user obtains. A different renderer, framework, persistence adapter, or data structure is not itself a gap.

Status values:

- ✅ **COMPLETE** — Thoughtslibrary provides an equivalent user-visible behavior.
- 🟡 **PARTIAL** — the main behavior exists, but one or more meaningful cases or capabilities are missing.
- 🔴 **MISSING** — the behavior is not available to a Thoughtslibrary mindmap user.
- 🟠 **DIFFERENT** — a related behavior exists, but the result or interaction is materially different.
- 🔵 **EQUIVALENT — DIFFERENT IMPLEMENTATION** — the behavior is equivalent; the implementation is intentionally different and is not a functional gap.
- ⚪ **UNKNOWN** — the source gives insufficient evidence to establish parity confidently.

Evidence is based primarily on the implementation and tests, with documentation used to clarify intended observable behavior. A type, operation, or comment that is not reachable from the Thoughtslibrary mindmap UI is not counted as an available user feature.

## 1. Executive Summary

The audit identified **146 distinct behavioral or scalability checkpoints**.

| Status | Count | Interpretation |
| --- | ---: | --- |
| ✅ COMPLETE | 19 | The user can obtain the same result in Thoughtslibrary. |
| 🟡 PARTIAL | 13 | The basic path exists, but the R-node behavior is broader or more robust. |
| 🔴 MISSING | 76 | The behavior is not currently available in the Thoughtslibrary mindmap. |
| 🟠 DIFFERENT | 22 | Thoughtslibrary does something related, but with a materially different interaction or result. |
| 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | 5 | Functionally equivalent despite a different implementation. |
| ⚪ UNKNOWN | 11 | The code does not establish the behavior with enough certainty. |
| **Total** | **146** |  |

### Main conclusion

Thoughtslibrary currently contains a functional mindmap foundation: it can open a sheet attached to a chart tile, create a child or sibling, rename a topic, delete a subtree, collapse a branch, apply several visual styles, select one node, pan, zoom, fit, undo, redo, persist the sheet, and display local images. Its layout, viewport culling, DOM measurement, and single-transform strategy are credible functional equivalents of several R-node outcomes.

The largest parity gaps are the **keyboard-first editing model**, **node drag and structural reparenting**, **multi-selection**, **rich text and HTML paste**, **copy/cut/paste**, **relationships/groups/summaries**, **four-sided image manipulation**, **R-node document import/export**, **explicit save semantics**, and **the image/performance controls required for very large maps**.

The feature is therefore not yet behaviorally equivalent to R-node. The core tree editor is present, but the current user workflow is toolbar- and mouse-oriented, with plain-text topic editing and a narrower structural feature set.

### Priority summary of the actionable gaps

- **P0:** keyboard creation/navigation, deletion, undo/redo hotkeys, structural drag and drop, multi-selection, rich text editing, clipboard operations, and reliable document interchange.
- **P1:** node movement/reparenting, floating topics, relationship/group/summary behavior, explicit save status, image drop/paste and resize handles, large-document image memory management.
- **P2:** advanced formatting controls, outline/Markdown interchange, node-image export, search/outliner/palette parity, gallery-like asset workflows.
- **P3:** presentation command parity, rare edge cases, extreme-scale verification, and secondary visual details.

## 2. Feature Matrix

The matrix is the complete checklist. Detailed explanations follow in sections 3–20.

| ID | Area | Funzionalità / comportamento | R-node | Thoughtslibrary | Stato | Priorità | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Editing | Creare un sibling con Enter | Crea un topic dopo quello selezionato e lo seleziona | Il pulsante Add sibling chiama `createSibling` | ✅ COMPLETE | P0 | Equivalenza via UI, hotkey mancante in K01 |
| F02 | Editing | Creare un child con Tab | Crea un figlio del topic selezionato | Il pulsante Add child crea il figlio del selezionato o della root | ✅ COMPLETE | P0 | Equivalenza via UI |
| F03 | Editing | Creare il parent del nodo | `createParent` inserisce un nuovo parent sopra il nodo | Nessuna azione mindmap equivalente nella UI o nello store esposto | 🔴 MISSING | P1 | Non confondere con Add child |
| F04 | Editing | Eliminare nodo e intero sottoalbero | Delete/Backspace rimuove la selezione e il sottoalbero, con undo | Delete nel toolbar rimuove il sottoalbero; la root è protetta | ✅ COMPLETE | P0 | Hotkey mancante |
| F05 | Editing | Duplicare un topic | `Mod+D` duplica topic e struttura prevista dal comando | Nessun duplicate topic nella feature mindmap | 🔴 MISSING | P1 | Il duplicato non è ottenibile con Add child/sibling |
| F06 | Editing | Spostare nodo prima/dopo/come figlio | Drag determina `before`, `after`, `child` e aggiorna parent, indice e layout | Nessun drag strutturale del nodo; le posizioni importate non sono editabili dalla UI | 🔴 MISSING | P0 | Gap core |
| F07 | Editing | Creare e usare topic floating | Doppio click sul canvas vuoto crea un floating topic; i main topic possono essere posizionati liberamente | Non esiste un comando floating né un gesto di creazione su canvas vuoto | 🔴 MISSING | P1 | Il tipo esiste nello schema TS, ma non è un comportamento utente disponibile |
| F08 | Editing | Selezione singola di topic | Click seleziona un nodo e aggiorna gli strumenti contestuali | Click su MindmapNode seleziona il nodo | ✅ COMPLETE | P0 | Solo selezione singola |
| F09 | Editing | Multi-selezione con modifier | Shift/Ctrl/Cmd aggiunge o rimuove topic dalla selezione | `selection` è `string | null` e non supporta una selezione di nodi | 🔴 MISSING | P0 | Impedisce operazioni di gruppo |
| F10 | Editing | Selection rectangle / marquee | Drag sul canvas vuoto seleziona tutti i nodi nella regione, anche in additive mode | Il canvas vuoto serve al pan; non esiste marquee | 🔴 MISSING | P1 | |
| F11 | Editing | Operazioni su relazioni, gruppi e summary | R-node supporta relazioni indipendenti, boundary/group e summary, selezionabili e undoabili | I tipi/ops contengono campi e forme preparatorie, ma la mindmap store/UI non espone queste azioni | 🔴 MISSING | P1 | Codice preparatorio non equivale a feature raggiungibile |
| F12 | Editing | Collapse/expand di un nodo | Space alterna collapsed; il sottoalbero non viene mostrato e il layout lo tratta come leaf | Il toggle +/- sul nodo alterna `collapsed` e nasconde i discendenti | ✅ COMPLETE | P0 | Escape/navigation differiscono |
| F13 | Editing | Expand all di un sottoalbero | Comando `expandAll` apre ricorsivamente il sottoalbero | Nessun controllo o azione `expandAll` nella mindmap feature | 🔴 MISSING | P2 | |
| F14 | Editing | Editing inline del testo | Un solo overlay Lexical, rich text, draft live, commit centralizzato, canvas senza ghosting | Doppio click monta un `contenteditable` dentro il nodo; testo plain e commit su blur/Enter | 🟠 DIFFERENT | P0 | Entrambi sono inline, ma il modello del contenuto e il ciclo di commit differiscono molto |
| F15 | Editing | Type-to-edit | Un carattere stampato su un topic selezionato apre l'editor con quel carattere come primo contenuto | Nessun handler globale per type-to-edit nella mindmap | 🔴 MISSING | P0 | |
| F16 | Editing | Newline durante editing | Enter commit nel modello R-node; il rich editor gestisce i break tramite il percorso Lexical; Shift+Enter mantiene il comportamento del rich editor | Enter senza Shift committa; il contenteditable può rappresentare testo multilinea solo nel percorso browser, senza modello strutturato | 🟡 PARTIAL | P0 | Non esiste un equivalente stabile per paragrafi/rich text |
| F17 | Editing | Titoli rich text persistenti | Titoli come `TextRun[]`, con sincronizzazione `title`/`titleRuns` | Mindmap title è una stringa plain; `titleRuns` è presente nel tipo ma non usato dalla UI mindmap | 🔴 MISSING | P0 | |
| F18 | Editing | Paste plain text su nodo selezionato | `Mod+V` può avviare type-to-edit/paste sul nodo selezionato; il testo entra nel flusso di editing | Il browser può incollare testo dentro il contenteditable già aperto, ma non esiste paste-to-edit su nodo selezionato | 🟡 PARTIAL | P0 | Solo contesto editor già aperto |
| F19 | Editing | Paste rich text | HTML da Word/Google Docs/Draw.io passa dalla sanitizzazione e mantiene struttura utile | Nessun percorso `text/html` o converter rich text nel mindmap overlay | 🔴 MISSING | P0 | |
| F20 | Editing | Sanitizzazione e conversione HTML | Rimuove script/layout non desiderato, converte enfasi Word, liste, heading e produce runs | Nessuna sanitizzazione HTML specifica della mindmap; il contenteditable usa il comportamento browser | 🔴 MISSING | P0 | Il Markdown editor dei notes è un altro prodotto |
| F21 | Clipboard | Copy della selezione strutturale | Copia un payload applicativo con nodi, root e relazioni, rimappabile al paste | Nessun copy della selezione mindmap | 🔴 MISSING | P0 | |
| F22 | Clipboard | Copy outline indentato | `Mod+Shift+C` copia una gerarchia testuale indentata | Nessun copy outline della mindmap | 🔴 MISSING | P1 | |
| F23 | Clipboard | Cut/paste strutturale | `Mod+X` copia e cancella; `Mod+V` ricrea la struttura con nuovi id | Nessun cut/paste strutturale della mindmap | 🔴 MISSING | P0 | |
| F24 | History | Undo di editing e struttura | Ogni gesto significativo è un batch undoabile; il rich text torna ai runs precedenti | `History` per batch di ops; rename, delete, create, collapse e style passano dalla history | ✅ COMPLETE | P0 | Equivalenza per le operazioni realmente esposte |
| F25 | History | Redo e invalidazione redo dopo nuova modifica | Redo ripete il batch; una nuova modifica dopo undo svuota redo | La classe `History` implementa la stessa regola | ✅ COMPLETE | P0 | Hotkey non collegata |
| F26 | Editing | Comportamento di testo vuoto alla chiusura | R-node elimina il nodo vuoto se leaf, altrimenti ripristina il titolo originale | Thoughtslibrary trimma e non applica la modifica vuota; non elimina automaticamente il leaf | 🟡 PARTIAL | P1 | Risultato diverso sui nodi nuovi vuoti |
| K01 | Keyboard | Enter crea sibling | Handler globale `Enter` | Nessun keydown mindmap che richiami Add sibling | 🔴 MISSING | P0 | |
| K02 | Keyboard | Tab crea child e non sposta il focus browser | Handler globale previene default e crea child | Nessun handler mindmap per Tab | 🔴 MISSING | P0 | |
| K03 | Keyboard | Shift+Tab promote | La configurazione dichiara promote, ma l'handler attuale esclude Tab dal modifier: il comportamento osservato è `Shift+Tab` → create child | Nessun handler Shift+Tab | 🔴 MISSING | P0 | Audit del comportamento osservato, non dell'intenzione dichiarata; R-node ha un bug noto |
| K04 | Keyboard | Frecce navigano la struttura | ArrowUp/Down/Left/Right chiamano `navigate` con geometria/relazioni | Nessun handler di navigazione mindmap | 🔴 MISSING | P0 | |
| K05 | Keyboard | F2 apre editing | `F2` chiama startEdit | Nessun F2 mindmap | 🔴 MISSING | P1 | |
| K06 | Keyboard | Space collassa/espande | `Space` alterna collapsed | Nessun Space mindmap | 🔴 MISSING | P0 | |
| K07 | Keyboard | Delete/Backspace cancella il target attivo | Cancella nodo, immagine, relazione, gruppo o summary in base al focus | Nessun Delete/Backspace mindmap; il browser gestisce solo l'editing plain eventualmente aperto | 🔴 MISSING | P0 | |
| K08 | Keyboard | Mod+Z / Mod+Shift+Z / Mod+Y | Undo/redo globale della mappa | Nessun routing delle hotkey globali al mindmap store | 🔴 MISSING | P0 | Il chart store ha history diversa |
| K09 | Keyboard | Mod+C/X/V e copy outline | Clipboard applicativo e testo gerarchico | Nessun routing clipboard mindmap | 🔴 MISSING | P0 | |
| K10 | Keyboard | Mod+S durante editing o normale | Commit draft + salvataggio manuale | Il mindmap store autosalva dopo le mutation; non espone Mod+S nel contesto overlay | 🔴 MISSING | P0 | Il salvataggio del chart principale non equivale al salvataggio manuale della sheet |
| K11 | Keyboard | Mod+1 / fit view | Fit della mappa | Fit è disponibile come pulsante, non come hotkey mindmap | 🔴 MISSING | P1 | Il comportamento UI esiste, l'accesso tastiera no |
| K12 | Keyboard | Mod+=, Mod+-, Mod+0 | Zoom step, zoom out, reset/fit | Nessuna hotkey mindmap; zoom solo wheel e Fit | 🔴 MISSING | P1 | |
| K13 | Keyboard | Escape | Chiude palette/relazioni/selezione secondo il contesto | Escape chiude l'overlay; nell'editor inline annulla il testo | 🟠 DIFFERENT | P1 | R-node usa Escape come navigazione gerarchica di contesto; Thoughtslibrary lo usa come close modal |
| K14 | Keyboard | Type-to-edit da tastiera | Qualunque carattere stampabile avvia edit | Nessun comportamento | 🔴 MISSING | P0 | |
| K15 | Keyboard | Enter/Shift+Enter nel text editor | Commit e gestione rich-text/newline secondo Lexical | Enter committa sempre se non Shift; nessun ricco percorso strutturato | 🟠 DIFFERENT | P0 | |
| P01 | Pointer | Click su nodo | Seleziona; click ripetuto non deve refloware lo stato inutilmente | Seleziona il nodo | ✅ COMPLETE | P0 | |
| P02 | Pointer | Click su canvas vuoto | Cancella selezione e può iniziare marquee | Avvia pan sul ground; non esiste un clear-selection equivalente esplicito sul click vuoto | 🟠 DIFFERENT | P1 | Il canvas vuoto ha semantica diversa |
| P03 | Pointer | Double click su nodo | Apre l'overlay rich text | Apre contenteditable inline | 🟠 DIFFERENT | P0 | Editing disponibile ma contenuto plain |
| P04 | Pointer | Double click su canvas vuoto | Crea un floating topic nella posizione | Nessuna creazione sul canvas vuoto | 🔴 MISSING | P1 | |
| P05 | Pointer | Right-drag pan | Pan con tasto destro; click destro semplice può aprire context menu | Il ground pan usa sinistro o middle; right click non pan è gestito come menu/browser | 🟠 DIFFERENT | P1 | |
| P06 | Pointer | Middle-drag pan | Pan ovunque, incluso durante editing | Middle-drag pan sul ground; non è garantito sopra ogni nodo/overlay | 🟡 PARTIAL | P1 | Copre il percorso base |
| P07 | Pointer | Wheel pan e Ctrl/Cmd+wheel zoom | Wheel normale pan; Ctrl/Cmd+wheel zoom centrato sul cursore | Ogni wheel chiama zoom; non esiste la distinzione Ctrl/Cmd per pan | 🟠 DIFFERENT | P0 | Cambia direttamente la navigazione |
| P08 | Pointer | Zoom ancorato al cursore | Il world point sotto il cursore resta fisso | `zoomAt` mantiene il punto screen ancorato e clampa 0.1–4 | ✅ COMPLETE | P0 | Implementazione diversa, comportamento equivalente |
| P09 | Pointer | Hover topic/drop/resize feedback | Hover topic, resize handles, drag target e drop mode sono visibili | Nessun hover node/drop/resize feedback specifico nella mindmap | 🔴 MISSING | P1 | |
| P10 | Pointer | Context menu sul nodo | Menu con new subtopic/code topic/delete/color e azioni contestuali | Nessun NodeContextMenu nella feature mindmap | 🔴 MISSING | P1 | |
| P11 | Pointer | Drag del nodo | Drag live, indicatore before/after/child/floating, commit singolo undo | MindmapNode non è draggable e non esiste drop handler strutturale | 🔴 MISSING | P0 | |
| P12 | Pointer | Drop indicator | L'utente vede dove il nodo verrebbe inserito | Nessun indicatore di drop | 🔴 MISSING | P1 | |
| P13 | Pointer | Selection rectangle | Drag sul vuoto seleziona una regione | Nessun marquee | 🔴 MISSING | P1 | |
| P14 | Pointer | Interazione immagini embedded | Immagine selezionabile, spostabile tra nodi/slot, con hit testing | L'immagine è una parte passiva del div; non è un target separato | 🔴 MISSING | P1 | |
| P15 | Pointer | Hit testing di relazioni/group/summary | Curve, boundary e summary sono target selezionabili | MindmapEdges ha `pointer-events:none`; non esistono target equivalenti | 🔴 MISSING | P1 | |
| L01 | Layout | Root con rami a sinistra/destra | Mindmap layout distribuisce i main topic ai due lati e bilancia per altezza | `layoutSheet` implementa split left/right e `autoBalance` | ✅ COMPLETE | P0 | Equivalenza osservabile |
| L02 | Layout | Discendenti in colonna accanto al parent | I sottoalberi vengono disposti verticalmente per ramo | `placeMindmap` dispone i child non-root in colonna | ✅ COMPLETE | P0 | |
| L03 | Layout | Box dimensionato da testo multilinea | Misura wrap, font, padding, shape e contenuto | DOM measurement reale con hidden measure layer e CSS condiviso | ✅ COMPLETE | P0 | |
| L04 | Layout | Separazione e collision avoidance | Ricalcolo evita overlap e mantiene gap tra rami | `resolveIntersections` e gap di branch evitano collisioni | ✅ COMPLETE | P0 | |
| L05 | Layout | Ricalcolo dopo modifica senza saltare la geometria | R-node applica layout debounced circa 30 ms e aggiorna i rami | Thoughtslibrary ricalcola attraverso watchers/`applySizes`; non replica lo stesso debounce e può ripassare più spesso | 🟠 DIFFERENT | P1 | Il risultato stabile è simile, il comportamento temporale/performance è diverso |
| L06 | Layout | Posizioni manuali preservate dopo reflow | Drag di main/floating imposta posizione manuale; auto-layout fluisce attorno | Il modello ha `position.manual`, ma non esiste un gesto per creare/modificare tale posizione | 🟡 PARTIAL | P1 | Supporto dati senza workflow completo |
| L07 | Layout | Configurare struttura/orientamento/spacing | Inspector/commands cambiano struttura, orientation, spacing, branch spacing e auto-balance | La struttura è nel tipo/store, ma la mindmap UI non espone controlli per modificarla | 🔴 MISSING | P1 | |
| L08 | Layout | Collapsed subtree non occupa lo spazio dei discendenti | Il ramo collassato è trattato come leaf e i figli non vengono disegnati | `hiddenIds` esclude i discendenti e layout tratta collapsed come leaf | ✅ COMPLETE | P0 | |
| L09 | Layout | Comportamento su profondità estrema | R-node ha ricorsioni e limiti solo parziali; il codice contiene rischi di stack overflow su input ciclico/profondo | Non c'è evidenza sufficiente di comportamento stabile su profondità estrema | ⚪ UNKNOWN | P3 | Richiede test runtime dedicato |
| R01 | Rendering | Render selettivo di soli nodi vicini alla viewport | Canvas culla i nodi visibili; gli edge restano se la curva attraversa il viewport | Thoughtslibrary culla i DOM node con `cullNodes`; MindmapEdges usa union/bulge visibility | 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | P1 | Nessuna mancanza funzionale; tecnica DOM/SVG diversa |
| R02 | Rendering | Forme di nodo | rounded, rect, capsule, circle, diamond, hexagon, cloud, underline, none e custom nel renderer R-node | UI mindmap espone rounded, rect, capsule, underline, none; altri tipi non sono raggiungibili/renderizzati dalla feature | 🟡 PARTIAL | P2 | Il tipo contiene più valori del comportamento UI effettivo |
| R03 | Rendering | Stili di nodo | Fill/stroke/border/shape/text color/font/weight/italic/underline/strike/shadow/opacity/align/width | Inspector copre molti campi, ma non espone tutte le opzioni R-node e l'allineamento è limitato | 🟡 PARTIAL | P2 | |
| R04 | Rendering | Stati selection/hover/editing/collapsed | Anello di selezione, hover, editing senza ghosting, drop state, collapsed state | Selezione/collapsed/editing sono presenti; hover/drop e no-ghosting non hanno lo stesso modello | 🟠 DIFFERENT | P1 | |
| R05 | Rendering | Rendering di relazioni con frecce e label | Curve/straight/elbow, arrowhead, colore, stile, label, bidirezionalità | Nessuna relazione mindmap raggiungibile; gli edge tree sono solo parent-child | 🔴 MISSING | P1 | |
| R06 | Rendering | Boundary/group e summary brace | Boundary dashed e summary brace vengono dipinti e selezionati | Nessun rendering equivalente nella mindmap | 🔴 MISSING | P1 | |
| R07 | Rendering | Immagini nel nodo e più slot | R-node riserva top/bottom/left/right, mantiene proporzioni e integra testo | Thoughtslibrary mostra una sola immagine top, con box CSS e width/aspect | 🟡 PARTIAL | P1 | Vedi I05/I06 |
| R08 | Rendering | Export di un singolo nodo come PNG/JPEG | Renderer R-node genera immagine del topic | Nessun export del singolo mindmap node | 🔴 MISSING | P2 | |
| R09 | Rendering | Tema e palette coerenti tra canvas/editor/export | Theme data risolve colori per renderer, overlay, SVG/PDF/HTML | Thoughtslibrary eredita font/colore dal chart e usa CSS; gli export mindmap visivi non sono equivalenti | 🔴 MISSING | P2 | |
| T01 | Rich text | Bold per porzione di titolo | Toolbar e Ctrl/Cmd+B su selezione; run bold persistente | Inspector può rendere bold l'intero nodo, non una porzione del titolo | 🔴 MISSING | P0 | |
| T02 | Rich text | Italic per porzione | Run italic persistente | Inspector italic è una proprietà dell'intero node | 🔴 MISSING | P0 | |
| T03 | Rich text | Underline per porzione | Run underline e toolbar | Inspector underline è node-level | 🔴 MISSING | P0 | |
| T04 | Rich text | Strike per porzione | Run strikethrough e comportamento canvas/editor | Inspector strike è node-level; nessuna porzione | 🔴 MISSING | P0 | |
| T05 | Rich text | Colori per porzione | Colore per run, clear senza perdere font-size | Inspector text color è node-level | 🔴 MISSING | P0 | |
| T06 | Rich text | Heading/font-size per blocco | h1–h6 convertiti in fontSize run e misurati | Solo font size dell'intero nodo; nessun heading block | 🔴 MISSING | P0 | |
| T07 | Rich text | Liste puntate annidate | Liste Word/HTML convertite in listIndent e renderizzate con hanging indent | Nessuna lista nel titolo mindmap | 🔴 MISSING | P0 | |
| T08 | Rich text | Paragrafi e paragraph gaps | `paraGap` preserva blocchi e spaziatura | Plain title e CSS pre-wrap non modellano paragraph blocks persistenti | 🔴 MISSING | P0 | |
| T09 | Rich text | Line break interno senza commit | Editor Lexical separa newline/commit secondo il contesto | Il contenteditable usa un comportamento browser non serializzato come runs | 🔴 MISSING | P0 | |
| T10 | Rich text | Link | R-node non supporta link nei TextRun: la capability di riferimento è assente | Thoughtslibrary non supporta link nel titolo | 🟠 DIFFERENT | P2 | Equivalenza rispetto al comportamento effettivo R-node; non è un gap R-node→TS |
| T11 | Rich text | Immagini/embedded/table/RTL nei titoli | R-node documenta queste capacità come non supportate o limitate | Thoughtslibrary non le supporta | 🟠 DIFFERENT | P3 | La matrice registra la parità con il comportamento reale, non con feature ipotetiche |
| T12 | Rich text | Paste Word/Google/Draw.io | Sanitizza markup, conserva enfasi/list/heading e scarta layout | Nessun import HTML nella mindmap | 🔴 MISSING | P0 | |
| T13 | Rich text | Round-trip editor → modello → renderer | R-node ha `TextRun[]`, invariant plain title, test e harness di parità | Thoughtslibrary serializza solo plain title | 🔴 MISSING | P0 | |
| T14 | Rich text | Editing di note rich text associato al topic | R-node notes sono plain text; rich text di riferimento vale per il titolo | La mindmap non mostra note editor del topic | 🔴 MISSING | P2 | Il notes editor del chart tile non è lo stesso comportamento |
| T15 | Rich text | IME/composition guard | R-node documenta un gap noto: la guardia IME era ancora roadmap | Non determinabile per il contenteditable Vue | ⚪ UNKNOWN | P3 | Nessuna conclusione positiva per assenza di prova |
| I01 | Images | Import immagine da file picker | R-node importa immagini allowlisted e le lega al topic | Mindmap inspector seleziona file `image/*`, ottimizza e salva in asset store | ✅ COMPLETE | P1 | Diversa persistenza, stesso risultato base |
| I02 | Images | Drop file direttamente sul topic | Explorer/browser drop sul nodo importa immagine | Il drop handler della mindmap non gestisce file image sul topic | 🔴 MISSING | P1 | |
| I03 | Images | Paste immagine sul topic | Ctrl/Cmd+V e Clipboard DataTransfer importano file immagine | Nessun paste listener della mindmap per immagini | 🔴 MISSING | P1 | |
| I04 | Images | Drop/paste URL immagine | R-node accetta `text/uri-list` e tenta fetch dell'asset | Mindmap inspector non espone URL image o drop URL | 🔴 MISSING | P2 | |
| I05 | Images | Ridimensionare immagine mantenendo aspect ratio | Slider Inspector e handle sul canvas; un gesto = un op | Input numerico per image width; altezza derivata dall'aspect, nessun handle canvas | 🟡 PARTIAL | P1 | Risultato dimensionale possibile, gesto diverso |
| I06 | Images | Quattro slot top/bottom/left/right e movimento tra nodi | Immagini selezionabili, con side slot e drag tra topic | Un solo slot top e immagine non selezionabile separatamente | 🔴 MISSING | P1 | |
| I07 | Images | Gallery/multi-image body | R-node ha gallery/celle, caption, reorder cross-tier e hit testing | Nessuna gallery nella mindmap feature | 🔴 MISSING | P2 | |
| I08 | Images | Immagine mancante/non decodificabile | R-node segnala asset missing nei toast/export e gestisce livelli/cache | `resolveStoredImageUrl` restituisce stringa vuota; il nodo resta senza immagine senza stato UI equivalente | 🟠 DIFFERENT | P2 | Comportamento di errore diverso |
| I09 | Images | Persistenza locale degli asset senza inserire bytes nel modello | R-node usa AssetStore separato; Thoughtslibrary usa IndexedDB condiviso + `local-asset://` e il foglio mantiene riferimenti | 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | P1 | La tecnologia e gli id differiscono, il risultato di separare byte e documento è equivalente |
| I10 | Images | Risoluzione e qualità adattate allo zoom | R-node sceglie livelli 256/1024 e decodifica con budget in byte | Il browser carica il blob con `<img>`; non c'è una politica mindmap equivalente verificabile di livelli/LRU | ⚪ UNKNOWN | P1 | La qualità/performance a zoom estremo richiede prove su carico reale |
| I11 | Images | Unloading/lazy decode/release esplicito | ImageBitmap cache LRU, `close()`, coda decode e solo nodi visibili | Object URL cache condivisa senza lifecycle/unload equivalente nella mindmap | 🔴 MISSING | P1 | Ottimizzazione necessaria per grandi mappe |
| I12 | Images | Immagini preservate negli export della mappa | R-node include immagini in PNG/SVG/HTML/PDF/.rnode.zip | La sheet viene inlined nei backup dati, ma il mindmap overlay è escluso da alcuni export visuali; non c'è export map equivalente verificato | 🔴 MISSING | P1 | Distinguere data backup da resa visuale |
| S01 | Persistence | Salvataggio manuale esplicito | R-node non autosalva; Ctrl+S decide quando scrivere e mostra Saved/Unsaved | Mindmap salva con debounce 500 ms dopo mutation e flush alla chiusura | 🟠 DIFFERENT | P0 | Il salvataggio automatico è una policy diversa, non una semplice implementazione |
| S02 | Persistence | Documento utente come file singolo `.rnode` | Desktop: una SQLite `.rnode` con documento e immagini; web: `.rnode.json/.zip` | La sheet vive in IndexedDB e il chart conserva un `sheetId`; non esiste un file mindmap nativo equivalente | 🟠 DIFFERENT | P0 | |
| S03 | Persistence | Riaprire la sheet associata allo stesso contesto | R-node apre/carica documenti locali; Thoughtslibrary riapre la sheet tramite id memorizzato nel chart | 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | P1 | L'utente ritrova la propria mappa nel contesto associato |
| S04 | Persistence | Errore di salvataggio osservabile e non silenzioso | R-node riporta errori di load/save e stato sync; non finge un salvataggio riuscito | `writeSheet` logga e risolve; la UI non espone un errore/stato mindmap equivalente | 🟠 DIFFERENT | P1 | |
| S05 | Persistence | Schema versionato e migrazione documenti | R-node ha schema version, import validation e percorsi legacy `.rmind/.rnode` | Thoughtslibrary dichiara schema 0.1, ma la sheet storage non implementa una pipeline di migrazione comparabile | 🟡 PARTIAL | P1 | Versione presente, migrazione non dimostrata |
| S06 | Persistence | Assenza di autosave | Il comportamento di riferimento è manual-save-only | Thoughtslibrary autosalva su timer e flusha in open/close | 🟠 DIFFERENT | P0 | È una differenza intenzionale ma rilevante per l'esperienza |
| S07 | Persistence | Indicatore Saved/Unsaved per la mindmap | Statusbar R-node mostra sync e ultima operazione | Overlay mindmap non mostra stato di salvataggio della sheet | 🔴 MISSING | P1 | |
| S08 | Persistence | Asset e documento atomici nello stesso container desktop | R-node desktop salva document + asset nello stesso `.rnode` transaction | Thoughtslibrary separa sheet IndexedDB e asset IndexedDB; export li ricompone solo in percorsi specifici | 🟠 DIFFERENT | P1 | Risultato locale possibile, atomicità/container diverso |
| S09 | Persistence | Recovery da documento corrotto/cancellato | R-node classifica errori di file e impedisce una perdita silenziosa | Thoughtslibrary non dimostra recovery specifico della sheet corrotta | ⚪ UNKNOWN | P1 | |
| E01 | Import/Export | Export `.rnode.json` | R-node serializza documenti portabili JSON | Thoughtslibrary export chart `.topster`, non `.rnode.json` mindmap | 🔴 MISSING | P0 | |
| E02 | Import/Export | Export/import `.rnode.zip` completo/compact | R-node zip include documento e livelli/originali asset, con compact dichiarato | Thoughtslibrary usa backup chart compresso e inlining asset in un formato diverso | 🔴 MISSING | P0 | Non è interoperabilità R-node |
| E03 | Import/Export | Export Markdown outline | R-node produce outline Markdown della gerarchia | Thoughtslibrary ha Markdown per notes, non export Markdown della mindmap | 🟠 DIFFERENT | P1 | Markdown presente nel prodotto ma per un contenuto diverso |
| E04 | Import/Export | Export visuale PNG | R-node esporta la mappa dal renderer | Thoughtslibrary può esportare il chart principale; il mindmap overlay è marcato `data-html2canvas-ignore` e non è un export mindmap equivalente | 🟡 PARTIAL | P1 | |
| E05 | Import/Export | Export visuale SVG | R-node produce SVG con testo, relazioni e immagini | Nessun SVG export della mindmap Thoughtslibrary | 🔴 MISSING | P1 | |
| E06 | Import/Export | Export HTML viewer | R-node produce viewer HTML standalone con dati/asset | Nessun HTML viewer standalone della mindmap | 🔴 MISSING | P1 | |
| E07 | Import/Export | Export PDF della mappa | R-node genera PDF della sheet con testo e immagini | Il PDF Thoughtslibrary è per il chart/notes; il percorso mindmap non è provato come incluso | 🔴 MISSING | P1 | |
| E08 | Import/Export | App clipboard format per sottografi | R-node copia nodi/relazioni e rimappa id al paste | Nessun formato clipboard mindmap | 🔴 MISSING | P0 | |
| E09 | Import/Export | Preservazione di formatting/strutture/immagini nei round-trip | R-node ha import/export distinti e test per rich text/assets | Thoughtslibrary sheet backup può preservare i plain node e riferimenti asset, ma non rich text/operazioni avanzate | 🔴 MISSING | P1 | |
| E10 | Import/Export | Import di formati ulteriori e contenuti complessi | R-node dichiara `.rmind`, Word/Google/Draw.io rich paste; altri formati sono roadmap | Non determinabile oltre i formati chart/topster del prodotto | ⚪ UNKNOWN | P2 | |
| O01 | Options | Toolbar Add child/Add sibling/Delete/Fit/Close | R-node toolbar/palette offre comandi equivalenti | Thoughtslibrary toolbar espone gli stessi cinque comandi principali | ✅ COMPLETE | P0 | La superficie UI è diversa, l'azione base è presente |
| O02 | Options | Inspector di stile del topic | R-node Inspector modifica molti campi e task/notes | Thoughtslibrary Inspector modifica fill/text/border/radius/width/font/flags/shape/image | 🟡 PARTIAL | P1 | Mancano task/labels/markers/alcune forme/allineamento/relazioni |
| O03 | Options | Struttura, orientation, spacing, auto-balance | R-node espone configurazioni layout e auto-layout | Thoughtslibrary non espone questi controlli nella mindmap overlay | 🔴 MISSING | P1 | |
| O04 | Options | Tema/font/background ereditato e visualizzazione | R-node risolve theme e palette in tutta la mappa | Thoughtslibrary eredita font/text color/background dal chart e usa CSS | 🟠 DIFFERENT | P2 | Risultato visuale correlato, policy tema diversa |
| O05 | Options | Palette, search e outliner per la mappa | R-node ha palette Ctrl+K, ricerca e outliner sincronizzato | Thoughtslibrary mindmap non ha palette/search/outliner propri | 🔴 MISSING | P1 | |
| O06 | Options | Task status/priority/completion | R-node ha task model e `Mod+Enter` complete, Inspector task | Thoughtslibrary mindmap type porta `TaskInfo`, ma store/UI non espone task editing | 🔴 MISSING | P2 | |
| O07 | Options | Context menu e comandi contestuali | R-node right-click sul topic apre menu con azioni | Nessun context menu mindmap | 🔴 MISSING | P1 | |
| O08 | Options | Opzioni immagini | R-node slot/width/resize/drop/paste/export/originals | Thoughtslibrary image add/replace/remove/width via Inspector, senza gli altri percorsi | 🟡 PARTIAL | P1 | |
| O09 | Options | Presentation mode | R-node `Mod+P` viene consumato ma mostra toast che la feature è ancora Phase 4; non entra in presentation reale | Nessun comando corrispondente nella mindmap | 🔴 MISSING | P3 | Parità del comportamento osservato, non della feature futura |
| Q01 | Performance | Culling della viewport | R-node disegna solo nodi visibili e conserva edge che attraversano lo schermo | Thoughtslibrary monta solo DOM nodes vicini e calcola edge visibility con margine/bulge | 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | P1 | Equivalente funzionale; DOM/SVG non è una mancanza |
| Q02 | Performance | Bitmap cache del testo e costo pan/zoom | R-node rasterizza testo statico per nodo e riusa bitmap durante pan/zoom | Thoughtslibrary usa DOM/CSS e un singolo transform; il costo reale su titoli molto lunghi non è stabilito | ⚪ UNKNOWN | P1 | Possibile equivalente pratico, non provato per stessa scala |
| Q03 | Performance | Pan/zoom come operazione composited | R-node coalesca paint con rAF e usa camera senza rilayout per ogni pan | Thoughtslibrary usa un solo CSS transform sul world; pan/zoom aggiorna camera e compositor | 🔵 EQUIVALENT — DIFFERENT IMPLEMENTATION | P1 | Stesso obiettivo osservabile, tecnica differente |
| Q04 | Performance | Layout debounced/incremental e batching | R-node debounced layout e op batch per gesto; il layout è derivato | Thoughtslibrary fa measurement batch, ma il store può ricalcolare layout ad ogni `applySizes` e autosave è separato | 🟠 DIFFERENT | P1 | Il comportamento su mappe grandi può differire |
| Q05 | Performance | Decode immagini in worker e livelli pre-scalati | R-node importa in worker e genera original/display 256/display 1024 | Thoughtslibrary non mostra un worker mindmap equivalente; `storeLocalImage` ottimizza il blob ma non replica la pipeline di decode | 🔴 MISSING | P1 | Ottimizzazione invisibile ma necessaria per scala |
| Q06 | Performance | LRU image cache con budget byte e `close()` | R-node limita bitmap decodificate per byte, aggiorna recency e chiude ImageBitmap | Thoughtslibrary object URL cache non espone budget byte, LRU o unload della bitmap | 🔴 MISSING | P1 | |
| Q07 | Performance | Scala dichiarata: migliaia/10.000 nodi e centinaia immagini | R-node documenta e testa stress a 10.000 topics/centinaia immagini | Thoughtslibrary culling commenta 3.000 topic, ma non prova la stessa soglia e la stessa memoria | ⚪ UNKNOWN | P1 | Serve benchmark comparabile, non inferenza dai commenti |
| X01 | Edge case | Nuovo documento/sheet vuota | R-node crea documento con root e titolo iniziale; resta editabile | `blankSheet('Untitled')` crea una root valida | ✅ COMPLETE | P0 | |
| X02 | Edge case | Root non cancellabile | R-node protegge la root e lascia il documento valido | `remove` rifiuta `rootNodeId`; toolbar disabilita delete root | ✅ COMPLETE | P0 | |
| X03 | Edge case | Node con migliaia di child | R-node layout/renderer hanno percorsi stress ma alcuni costi sono noti | Thoughtslibrary layout e DOM culling hanno fallback, ma la UX su migliaia di children non è stabilita | ⚪ UNKNOWN | P1 | |
| X04 | Edge case | Floating node con child | R-node consente il drop ma contiene un bug: children di floating possono sparire da render/export/search | Thoughtslibrary non offre floating; il modello appende nodi non raggiunti in `visibleNodes`, ma layout parte comunque dalla root | 🟠 DIFFERENT | P2 | Nessuna equivalenza diretta; comportamento di riferimento è difettoso ma osservabile |
| X05 | Edge case | Documento ciclico/malformato | R-node ha un bug documentato: import ciclico può causare stack overflow in layout/walk | Thoughtslibrary non valida la topologia in `open`/`readSheet` in modo comparabile | ⚪ UNKNOWN | P1 | Non dichiarare sicurezza senza prova |
| X06 | Edge case | Testo enorme | R-node può produrre box molto alte; roadmap segnala assenza di cap sui paste voluminosi | Thoughtslibrary CSS `overflow-wrap` gestisce il wrapping, ma non c'è un limite funzionale al testo | ⚪ UNKNOWN | P2 | Effetto su viewport/performance da verificare |
| X07 | Edge case | Immagine mancante o URL non risolvibile | R-node mantiene metadati/asset e segnala missing in export/render | Thoughtslibrary può mostrare box senza immagine quando il resolver restituisce stringa vuota | 🟠 DIFFERENT | P2 | |
| X08 | Edge case | Selezione multipla e cancellazioni complesse | R-node cancella batch/subtree e conserva un undo per gesto | Thoughtslibrary non ha multi-selection mindmap | 🔴 MISSING | P1 | |
| X09 | Edge case | Undo dopo delete/move/style complesso | R-node inverse-op ripristina subtree, relazioni e ordine | Thoughtslibrary inverse ops ripristinano create/delete/title/style/collapse; non c'è move/rel/group UI da confrontare | ✅ COMPLETE | P0 | Per il sottoinsieme implementato |
| X10 | Edge case | Zoom estremi/viewport molto grandi | R-node clampa 0.02–8 nel viewer e gestisce culling/cache; editor ha limiti propri | Thoughtslibrary clampa 0.1–4 e usa DOM; comportamento estremo non è stato dimostrato equivalente | ⚪ UNKNOWN | P2 | |

## 3. Keyboard & Input Behaviour

### R-node reference behavior

R-node is explicitly keyboard-first. The global handler in `src/editor/shortcuts.ts` consumes the following combinations when the map is not in the rich editor:

| Combination | Context | Observed action |
| --- | --- | --- |
| `Enter` | Topic selected | Create sibling. Prevents browser default. |
| `Tab` | Topic selected | Create child. Prevents focus traversal. |
| `Shift+Tab` | Topic selected | The configured action is promote, but the current combo builder excludes `Tab` from the Shift modifier. The observed behavior is therefore `Tab` → create child. This is a real R-node defect and is recorded as such. |
| `ArrowUp/Down/Left/Right` | Topic selected | Structural/spatial navigation. |
| `F2` | Topic selected | Open inline editor. |
| `Space` | Topic selected | Toggle collapse. |
| `Delete`, `Backspace` | Topic/image/relationship/group/summary selected | Delete the active target. |
| `Ctrl/Cmd+Z` | Map | Undo. |
| `Ctrl/Cmd+Shift+Z`, `Ctrl/Cmd+Y` | Map | Redo. |
| `Ctrl/Cmd+C` | Map | Copy structured selection. |
| `Ctrl/Cmd+Shift+C` | Map | Copy indented outline. |
| `Ctrl/Cmd+X` | Map | Cut structured selection. |
| `Ctrl/Cmd+V` | Map | Paste text, image, or structured payload according to clipboard content. |
| `Ctrl/Cmd+K` | Map | Open command palette. |
| `Ctrl/Cmd+F` | Map | Focus search. |
| `Ctrl/Cmd+S` | Map/editor | Commit active draft and perform explicit save. |
| `Ctrl/Cmd+O` | Map | Open file. |
| `Ctrl/Cmd+E` | Map | Export JSON. |
| `Ctrl/Cmd+D` | Topic selected | Duplicate topic. |
| `Ctrl/Cmd+Enter` | Topic selected | Toggle task complete. |
| `Ctrl/Cmd+=`, `Ctrl/Cmd+-`, `Ctrl/Cmd+0`, `Ctrl/Cmd+1` | Map | Zoom in, zoom out, reset/fit, fit view. |
| `Ctrl/Cmd+P` | Map | Consumed and shows a Phase 4 presentation toast; no real presentation mode exists yet. |
| `Escape` | Palette/relationship/gallery/selection | Closes the most specific active interaction. |
| Printable character | Topic selected | Type-to-edit. |

While the Lexical overlay is active, it owns the editing keyboard. Its observable behavior includes:

- Enter commits the edit in capture phase in the current implementation.
- Escape cancels and restores the exact pre-edit content.
- `Ctrl/Cmd+S` commits the draft but keeps the editor open.
- `Ctrl/Cmd+B`, `I`, `U` applies inline formatting to the selection.
- The toolbar applies color and other supported formatting.
- Wheel and pan remain active while editing; the overlay follows the camera.
- The canvas skips drawing the edited node, avoiding a duplicate/ghost representation.

### Thoughtslibrary result

The mindmap overlay has no global keyboard controller comparable to `src/editor/shortcuts.ts`. The toolbar exposes Add child, Add sibling, Delete, Fit, and Close. The node's local `contenteditable` handles Enter and Escape, but this is browser text editing rather than a map command system.

This is the largest usability gap: a user trained on R-node cannot perform the basic tree workflow with Enter/Tab/arrows/Space/Delete/undo hotkeys in Thoughtslibrary's mindmap. The underlying `History` supports undo/redo, but the behavior is not reachable through the R-node hotkeys.

## 4. Editing Behaviour

### Creation

R-node has distinct commands for sibling, child, parent, floating topic, code topic, and gallery topic. Thoughtslibrary currently exposes only child and sibling creation in the mindmap overlay. Its `NodeType` union includes `floating`, `summary`, and `callout`, and its op union includes many operations, but the user-facing mindmap store exposes only `createChild`, `createSibling`, `rename`, `remove`, `toggleCollapse`, style, selection, camera, history, and persistence.

### Rename lifecycle

R-node stores the original title and runs at edit start, applies a live draft, and commits a single `setTitle` operation. Escape restores the original exactly. Empty leaf handling is explicit: a newly created empty leaf can be removed on commit.

Thoughtslibrary starts a `contenteditable` on double click, selects all text, commits on blur or Enter, trims the value, and ignores an empty replacement. Escape only closes the local edit. This is a usable plain-text rename flow, but it differs in:

- no rich runs;
- no central draft model shared with layout;
- no type-to-edit;
- no explicit commit-while-staying-in-editor save path;
- no automatic deletion of an empty leaf;
- no map-level focus/navigation semantics.

### Structural edits

R-node drag can place a node before, after, or as a child of another node, and can make an eligible main topic floating. The drag is live: the node follows the cursor in the free-position zone, a drop indicator shows the result, and the final gesture is one undoable operation.

Thoughtslibrary has no node drag implementation in `MindmapCanvas.vue` or `MindmapNode.vue`. The `position` and `moveNode` shapes in the model/ops layer are not enough to claim parity because no mindmap UI invokes them.

### Undo/redo

For the subset that Thoughtslibrary exposes, its operation-based history is behaviorally equivalent: operations are batched, inverses are replayed in the correct order, redo is cleared after a new edit, and delete restores the subtree snapshot. This is one of the strongest parity areas.

## 5. Node / Tree Behaviour

R-node's tree model includes:

- one central root;
- main topics directly under the root;
- regular subtopics;
- floating topics;
- independent relationships;
- boundaries/groups;
- summaries;
- task, marker, label, notes, and metadata fields.

Thoughtslibrary's ported schema includes many corresponding fields, but its actual mindmap UI currently provides only a strict rooted tree with child/sibling creation, rename, delete, collapse, style, and one selected id. `visibleNodes` appends otherwise unreachable nodes so they do not vanish from the list, but the layout still starts from `rootNodeId`; this is not equivalent to R-node's floating workflow.

The following tree behaviors are consequently missing from the current UI:

- promote/demote through keyboard or command;
- create parent;
- sibling reordering;
- reparenting by drag;
- floating topic creation and placement;
- batch edits over a multi-selection;
- relationships independent of the parent-child tree;
- groups/boundaries and summary braces;
- task completion and task metadata editing;
- outliner navigation.

## 6. Layout Behaviour

### Equivalent outcomes

Thoughtslibrary's `src/mindmap/layout.ts` is a genuine functional port of the main observable R-node layout rules:

- node extents are derived from measured content;
- a topic and its descendants form a block;
- root children are split left/right;
- non-root children are placed in a vertical column beside the parent;
- branch spacing is explicit;
- collapsed nodes behave as leaves;
- intersections are resolved without moving manual anchors;
- the actual browser box is measured in a hidden layer before layout.

The use of a hidden DOM measurement layer is an implementation difference, not a functional deficiency. It directly addresses the same user-visible requirement: the map must wrap text and position boxes according to the dimensions the user sees.

### Differences and risks

R-node schedules layout after edits with a short debounce and uses a canvas renderer. Thoughtslibrary's Vue watcher/measurement loop can call `applySizes` as measurements converge and then write positions. The stable layout result is similar, but the timing, number of reactive passes, and large-map cost are different.

R-node offers user-positioned main/floating topics and explicit auto-layout behavior. Thoughtslibrary carries `position.manual` and a `force` parameter, but there is no current node drag or auto-layout control in the mindmap overlay. This is a partial data-model parity, not user parity.

## 7. Rendering & Visual Behaviour

R-node paints the complete map into one Canvas2D surface. Its renderer handles:

- topic shapes and borders;
- fill, text and branch colors;
- text runs, headings, bullets, underline and strike;
- images and image slots;
- selection rings and resize handles;
- relationships, groups, summaries and drop indicators;
- hover and editing states;
- culling and bitmap caches.

Thoughtslibrary renders a visible node as a DOM element, tree edges in SVG, and applies one CSS transform to a world container. The visual technology is different, but the basic node/edge/viewport result is equivalent for the supported subset. This is explicitly classified as equivalent-different-implementation where applicable.

The current UI style inspector supports a meaningful subset: fill, text color, stroke, radius, border width/style, font size, weight, opacity, bold, italic, underline, strike, shadow, and a limited shape list. It does not expose all R-node shapes, per-run formatting, branch colors, relationship styling, group/summary styling, or node export.

## 8. Rich Text / HTML Behaviour

This is a P0 parity gap.

R-node's title is rich text, not a plain string. The implementation preserves a sequence of runs with:

- bold;
- italic;
- underline;
- color;
- per-run font size/headings;
- paragraph boundaries and gaps;
- nested bullet-list indentation;
- newline semantics;
- round-trip conversion between Lexical and `TextRun[]`;
- sanitized HTML paste from Word, Google Docs, and Draw.io.

Thoughtslibrary's mindmap title is plain `MindNode.title`. Its `titleRuns` type field is not connected to `MindmapNode.vue`, `MindmapCanvas.vue`, or the mindmap store's rename path. The contenteditable can display and edit browser text, but the committed result is a trimmed string. No part of the current mindmap preserves inline formatting or block structure.

The chart's notes editor and Markdown helper do not close this gap. They operate on chart item notes, not on R-node-style rich titles embedded in the mindmap nodes.

## 9. Images & Assets

### R-node behavior

R-node supports a full node-image lifecycle:

1. import a file through picker, drag/drop, or paste;
2. validate image MIME and source size;
3. preserve the original;
4. generate display levels for efficient rendering;
5. associate the asset by content hash;
6. display it in a node with reserved layout space;
7. select and resize it while preserving aspect ratio;
8. move it between nodes/slots;
9. include it in exports and portable documents;
10. report missing/unreadable images instead of silently losing them.

### Thoughtslibrary behavior

Thoughtslibrary's mindmap supports one top image added by an Inspector file picker. The image is optimized and stored in the shared IndexedDB asset store; width and aspect are stored on the node, so layout does not wait for image loading. That is a real and useful equivalent for the basic “attach and display an image” path.

It does not currently expose:

- file drop onto a node;
- paste image onto a node;
- URL image drop/paste;
- bottom/left/right slots;
- image selection as a separate target;
- image drag between nodes;
- canvas resize handle;
- gallery cell behavior;
- R-node multi-level decode and explicit byte-budgeted bitmap lifecycle;
- reliable mindmap visual export with images.

The shared asset store is functionally equivalent to R-node's separation of document metadata from image bytes for persistence. The UUID/local URL strategy is an implementation difference. It does not, however, provide the same memory behavior as R-node's decoded-bitmap LRU.

## 10. Zoom / Viewport / Navigation

### Present in both

- camera pan state;
- zoom around a screen point;
- fit-to-view behavior;
- clamped zoom range;
- preservation of the camera through ordinary edits unless a fit is requested;
- viewport-aware rendering/culling.

Thoughtslibrary's `zoomAt` is a strong equivalent: it computes a scale and adjusts camera x/y so the world point under the cursor remains fixed.

### Material differences

R-node distinguishes normal wheel pan from Ctrl/Cmd-wheel zoom. Thoughtslibrary treats wheel as zoom regardless of modifier. R-node supports keyboard zoom commands, center-on-node, and richer navigation. Thoughtslibrary has only wheel, drag pan, and the Fit button in the mindmap overlay.

R-node keeps pan/zoom available while the rich editor is active and repositions the overlay with the camera. Thoughtslibrary's local contenteditable lives inside the transformed node, but because the entire world transform is shared, the basic visual tracking works; the rich editing semantics still differ.

## 11. Persistence

R-node's explicit-save behavior is intentional:

- edits become unsaved state;
- Ctrl/Cmd+S commits a draft if needed and writes the document;
- the UI reports Saved/Unsaved;
- web persistence uses local storage plus portable files;
- desktop persistence uses one `.rnode` file containing document and image data;
- open/save errors are surfaced;
- file identity and save-as conflicts are guarded.

Thoughtslibrary's mindmap uses IndexedDB sheets with a 500 ms autosave debounce. `open` and `close` flush pending writes. The chart stores only a sheet id, allowing the large sheet to remain outside localStorage. This is a reasonable local-first design, and the “reopen the sheet attached to the chart tile” behavior is equivalent, but it is materially different from R-node's user-controlled save model.

The current mindmap overlay has no sheet-level Saved/Unsaved status and does not offer a dedicated `.rnode`-style save/open workflow. The broader Thoughtslibrary chart import/export system should not be counted as mindmap document interoperability unless it demonstrably includes the visual and behavioral sheet content intended by R-node.

## 12. Import / Export

### R-node reference formats

R-node source and documentation establish these relevant formats and paths:

- `.rnode.json` document export/import;
- `.rmind.json` legacy import path;
- `.rnode.zip` with document and images;
- complete versus compact image payloads;
- Markdown outline export;
- PNG canvas export;
- SVG export;
- HTML viewer export;
- PDF export;
- structured application clipboard payload;
- sanitized rich HTML paste.

The format preserves or transforms content as follows:

- structural node ids are remapped on structured paste;
- parent/child order is preserved;
- relationships are preserved in the application payload and portable formats;
- `TextRun[]` formatting is preserved in the document model and SVG/HTML/PDF paths where supported;
- compact image packages preserve display levels but declare that originals are unavailable;
- export image paths use display-sized assets where appropriate to control file size;
- missing images are counted/reported rather than silently treated as valid.

Thoughtslibrary supports compressed `.topster` chart backups, Topsters 2 import, chart PDF, chart image export, and chart asset inlining. These are valid product features but not equivalent to R-node's mindmap interchange until the mindmap's structural, rich-text, relation, image, and visual export semantics are all included.

The current audit therefore marks R-node-specific JSON/ZIP/Markdown/SVG/HTML/PDF/clipboard paths as missing or partial, not because Thoughtslibrary lacks all export, but because the available export targets a different document boundary or a different content model.

## 13. Options / Configuration

### R-node options that affect behavior

- document title and document list;
- explicit save/open/export;
- theme;
- sheet structure and orientation;
- spacing and branch spacing;
- auto-balance;
- manual positioning/auto-layout;
- node shape, fill, stroke, border, shadow, opacity, font, alignment;
- task status and priority;
- labels and markers;
- image slots, image width, image import/export policy;
- palette, search, outliner, Inspector;
- relationships, groups, summaries;
- Zen/presentation-related commands;
- command context menu.

### Thoughtslibrary options currently reachable in the mindmap

- Add child;
- Add sibling;
- Delete selected subtree;
- Fit;
- Close;
- fill, text and border colors;
- radius, border width, border style;
- font size and weight;
- opacity;
- bold, italic, underline, strike, shadow;
- a limited shape list;
- add/replace/remove one top image;
- numeric image width;
- collapse/expand through the node +/- control;
- undo/redo through store methods, but not through map hotkeys.

The main difference is not merely visual styling. R-node's options control the editing model, tree topology, persistence, clipboard, and viewport. Thoughtslibrary currently exposes only a subset of those controls.

## 14. Performance / Scalability

### R-node optimizations and the behavior they protect

| Optimization | Purpose and protected behavior | Thoughtslibrary equivalent/status |
| --- | --- | --- |
| Canvas rendering with no DOM/SVG element per topic | Keeps thousands of topics drawable without mounting thousands of UI nodes | Thoughtslibrary uses DOM nodes but culls them and applies one world transform. This can be functionally equivalent at moderate scale, but same-scale performance is not proven. |
| Viewport culling | Avoids work for off-screen topics | Pure `cullNodes` plus `MindmapCanvas` is an equivalent strategy. |
| Edge visibility by curve/union, not both endpoints | Keeps an edge visible when an endpoint is off-screen but the curve crosses the viewport | `edgeVisible` implements the equivalent behavior. |
| rAF paint coalescing | Prevents multiple paints in one display frame during wheel/drag | Thoughtslibrary's CSS transform/compositor path avoids rebuilding per-node positions during pan/zoom, but there is no direct rAF paint equivalent. Functional result is similar; timing should be benchmarked. |
| Text bitmap cache per node | Avoids re-rasterizing rich text on every pan/zoom | DOM/CSS keeps text as browser-rendered content and the world transform moves it. This is an equivalent outcome with a different cost model, not automatically a gap. |
| Measurement cache | Avoids repeating text measurement unless content/style changes | Thoughtslibrary has `sizeCache` keyed by title and box-affecting style. Equivalent behavior. |
| Debounced layout | Prevents a full layout pass on every keystroke/measurement mutation | Thoughtslibrary batches measurement reads, but its exact debounce/recompute behavior differs. |
| Worker image ingestion | Keeps decode/resize/import work away from the main UI loop | No equivalent mindmap worker is evident. |
| Multiple display resolution levels | Allows quality appropriate to zoom while avoiding full-resolution decode | No equivalent levels policy is evident. |
| LRU bitmap cache bounded by bytes | Prevents hundreds of decoded images from consuming unbounded native bitmap memory | No equivalent budget/LRU/explicit bitmap release is evident. |
| `ImageBitmap.close()` on eviction | Actually releases decoded bitmap memory | No equivalent lifecycle is evident for the shared object URL cache. |
| Decode only visible image nodes | Avoids decoding hidden/off-screen assets | Thoughtslibrary does not explicitly decode images through an image-level visibility queue; browser behavior is not sufficient evidence of the same policy. |
| Asset deduplication by content hash | Prevents duplicate originals and makes one portable asset reference reusable | Thoughtslibrary stores asset blobs under generated ids; it has a shared store but not the same content-addressing evidence. The persistence result is usable, but storage dedup behavior differs. |
| Copy-on-write operation batches | Keeps undo atomic and avoids full document snapshots for normal edits | Thoughtslibrary mindmap store uses copy-on-write drafts and batched inverses. This is an equivalent implementation of the protected behavior. |
| Save queue/flush ordering | Prevents concurrent saves from losing newer edits | Thoughtslibrary's debounced `flushSave` handles normal close/open ordering, but the available code does not establish the same overlapping-save queue guarantees as R-node. |

### Scalability conclusions

1. **Node rendering:** Thoughtslibrary has a credible equivalent strategy for viewport use: measure all needed boxes, layout derived positions, cull real nodes, and move the world with one transform. This should not be called missing merely because it is DOM-based.
2. **Image memory:** parity is not established. R-node explicitly controls decoded levels, byte budget, LRU recency, and release. Thoughtslibrary stores optimized blobs and resolves object URLs, but that is a persistence/cache strategy, not proof of decoded bitmap memory control.
3. **Large-map proof:** R-node includes stress-oriented evidence for thousands of nodes and hundreds of images. Thoughtslibrary comments mention 3,000-topic culling, but the audit found no equivalent completed benchmark establishing behavior at 10,000 topics and hundreds of high-resolution images.
4. **Layout timing:** Both systems avoid measuring in the hot pan path, but Thoughtslibrary's reactive measurement convergence and autosave timing are different and should be treated as a separate performance risk.

## 15. Edge Cases

### Empty sheet and root protection

Both implementations create a valid root and prevent root deletion. This is complete parity for the basic empty-document lifecycle.

### Empty titles

R-node has explicit edit-commit rules for empty titles, including removal of an empty leaf. Thoughtslibrary ignores a trimmed empty replacement, leaving the existing title. The user-visible result differs for newly created blank topics.

### Floating subtrees

R-node's own code contains a known bug: dropping a child below a floating topic can make the child invisible to layout, render, search, counts, and exports because some consumers walk only the root and direct floating nodes. Thoughtslibrary does not implement the floating workflow at all. The correct parity backlog should not reproduce the bug, but it should record the reference behavior and decide whether the intended product contract is floating-leaf-only or floating-subtree support.

### Invalid/cyclic documents

R-node has a documented crash path for malformed cyclic imports. Thoughtslibrary's sheet loader returns stored objects without a comparable topology validation pass. Neither codebase should be assumed robust for arbitrary hand-edited cyclic data without a runtime probe and validation policy.

### Very deep or very wide trees

Both layouts use recursive walks. R-node has stress tests and known recursion risks on corrupt topology. Thoughtslibrary has no equivalent evidence for extreme depth or a root with thousands of direct children. These remain unknown, not complete.

### Missing images

R-node retains metadata and reports missing images in renderer/export diagnostics. Thoughtslibrary's resolver can return an empty URL and leave an empty image slot. The absence is observable, so this is a behavioral difference.

## 16. Behavioural Differences

The following are real behavioral differences, not stack differences:

1. R-node is keyboard-first; Thoughtslibrary mindmap is toolbar/mouse-first.
2. R-node Enter/Tab/arrows/Space/Delete are structural commands; Thoughtslibrary has no equivalent map-level handlers.
3. R-node supports multi-selection and marquee; Thoughtslibrary tracks one selected node.
4. R-node double click opens rich text editing; Thoughtslibrary opens plain text editing.
5. R-node can move/reparent nodes by drag; Thoughtslibrary cannot.
6. R-node double click on empty canvas creates a floating topic; Thoughtslibrary does nothing equivalent.
7. Normal wheel pans in R-node and Ctrl/Cmd-wheel zooms; Thoughtslibrary wheel zooms directly.
8. R-node right-drag pans; Thoughtslibrary uses left/middle ground pan.
9. R-node uses explicit save and exposes saved state; Thoughtslibrary autosaves a sheet after mutations without an overlay save state.
10. R-node has a portable `.rnode` document boundary; Thoughtslibrary stores sheets separately in IndexedDB and references them from charts.
11. R-node titles preserve rich inline/block structure; Thoughtslibrary commits a plain string.
12. R-node supports rich HTML paste; Thoughtslibrary mindmap does not.
13. R-node supports structured copy/cut/paste; Thoughtslibrary mindmap does not.
14. R-node supports relationships, groups, summaries, tasks, labels, and markers through user actions; Thoughtslibrary mindmap does not expose them.
15. R-node supports four image slots, image selection, image movement, drag/paste import, and canvas resize; Thoughtslibrary supports one Inspector-added top image and numeric width.
16. R-node has explicit decoded-image memory controls; Thoughtslibrary has no demonstrated equivalent.
17. R-node exports the map as PNG/SVG/HTML/PDF and portable data; Thoughtslibrary's existing visual exports target the chart and do not establish equivalent mindmap export.
18. R-node visibly reports more operational state, including save/export status and action feedback.

## 17. Missing Functionality

This section intentionally lists only behaviors classified as 🔴 MISSING in the matrix, ordered by priority. The matrix contains 76 missing rows.

### P0 — Core

- Enter creates sibling.
- Tab creates child and prevents focus traversal.
- Shift+Tab has a defined map behavior.
- Arrow-key structural navigation.
- Space collapse/expand hotkey.
- Delete/Backspace map deletion.
- Mod+Z / Mod+Shift+Z / Mod+Y map history hotkeys.
- Mod+C/X/V structured clipboard.
- Mod+S map save workflow.
- Type-to-edit.
- Rich title runs.
- Rich text formatting by selection: bold, italic, underline, strike, color.
- Heading/font-size blocks.
- Nested bullet lists.
- Paragraph gaps and structured line breaks.
- Word/Google Docs/Draw.io rich HTML paste.
- Structured selection copy payload.
- Cut/paste of subtrees.
- Node drag before/after/child/floating.
- Selection rectangle and multi-selection.

### P1 — Important

- Create parent.
- Duplicate topic.
- Floating topic creation.
- Expand all.
- Drop indicator.
- Hover/drop/resize feedback.
- Context menu.
- Relationship, group, summary interaction.
- Relational hit testing.
- Four image slots and image movement.
- Image file drop and image paste.
- Image visual export in the mindmap formats.
- `.rnode.json` interoperability.
- `.rnode.zip` complete/compact interoperability.
- Explicit Saved/Unsaved status.
- Dedicated mindmap file save/open boundary.
- Worker image ingestion.
- Multi-level image decode.
- Byte-bounded LRU bitmap cache and explicit bitmap release.
- Large-scale verification at R-node's documented target.
- Multi-selection behavior for complex deletion.

### P2 — Secondary

- `Mod+K` palette.
- `Mod+F` search.
- Outliner.
- Full structure/spacing/auto-balance controls.
- Task status and priority editing.
- All R-node node shapes.
- Single-node PNG/JPEG export.
- Image URL drop/paste.
- Gallery/multi-image body.
- SVG export.
- HTML viewer export.
- Markdown outline export as a mindmap format.
- PDF map export with mindmap content.
- Additional import formats beyond chart/topster.

### P3 — Edge / nice-to-have

- R-node's observed presentation shortcut behavior.
- Extreme viewport behavior verification.
- Extreme-depth behavior verification.
- IME behavior verification/guard.
- Rare embedded/table/RTL cases, subject to the fact that R-node itself documents these as unsupported or limited.

## 18. Partial Functionality

| Area | Present in Thoughtslibrary | Missing or different part |
| --- | --- | --- |
| Topic editing | Double-click plain contenteditable, blur/Enter commit, Escape cancel | No rich runs, no type-to-edit, no structured empty-leaf rule, no central draft parity |
| Newline | Browser contenteditable can represent line breaks in the open editor | No persistent paragraph/list model; Enter is a commit command |
| Paste text | Browser paste can work inside an already-open contenteditable | No paste-to-edit on a selected node; no rich HTML conversion |
| Image resize | Inspector numeric width with stored aspect | No canvas handle, no one-gesture drag resize, no four slots |
| Image styling | Add/replace/remove one top image and width | No file drop/paste/URL flow, image selection, move, or image-level export |
| Node visual styles | Many node-level CSS controls | No per-run text formatting, limited shape list, no relation/group/summary styling |
| Manual layout | `position.manual` exists and layout respects it | No user-facing node move/drag or auto-layout command in the feature |
| Rich content | Chart notes use Markdown and sanitized HTML rendering | That editor is not the mindmap title editor and does not provide R-node title parity |
| Export | Thoughtslibrary exports chart backups/PDF/image data | R-node mindmap formats and visual map exports are not established |
| Persistence | Sheet autosaves to IndexedDB and reopens via chart-linked id | Behavior differs from explicit R-node save, file identity, status, and atomic container |
| Error handling | Storage operations degrade/log in several paths | No equivalent visible sheet save/error status |
| Performance | DOM measurement cache, culling, edge visibility, one CSS transform | Image decode/memory policy and R-node large-scale proof are absent or unknown |

## 19. Equivalent but Different Implementation

These items should not be reimplemented merely to match R-node's technology:

1. **Viewport culling:** R-node uses a single canvas; Thoughtslibrary mounts only nearby DOM nodes and keeps an edge union visible when the curve intersects the viewport. The user-visible result is the same category of behavior.
2. **Camera transform:** R-node changes a camera used by Canvas2D; Thoughtslibrary applies one CSS transform to the world. Both preserve the map geometry during pan/zoom without per-node relayout.
3. **DOM measurement versus canvas measurement:** R-node shares a canvas text measurer with its renderer and editor. Thoughtslibrary measures actual styled DOM boxes in a hidden layer and uses those same CSS styles for live nodes. This is a valid functional equivalent for box sizing and wrapping.
4. **Local asset separation:** R-node uses an AssetStore with content-addressed ids and Thoughtslibrary uses a shared IndexedDB blob store with local asset URLs. Both keep large image bytes out of the main document object and permit local persistence.
5. **Undo implementation:** R-node and Thoughtslibrary both use operation batches with inverses for the implemented subset. The user gets atomic undo of create/delete/rename/collapse/style changes even though the surrounding stores differ.

## 20. Unknown / Needs Verification

These behaviors must not be marked complete until measured or tested directly:

1. Thoughtslibrary performance and usability at 10,000 nodes.
2. Thoughtslibrary behavior with hundreds of high-resolution images at multiple zoom levels.
3. Whether browser image decoding and object URL reuse provide acceptable memory behavior without an explicit R-node-style bitmap budget.
4. Very deep trees and very wide sibling lists.
5. Malformed or cyclic imported sheet topology.
6. Recovery after IndexedDB failure, quota exhaustion, browser eviction, or interrupted write.
7. IME composition behavior in the mindmap `contenteditable`.
8. Exact PDF/PNG behavior when a chart containing an open mindmap is exported.
9. Whether any uninspected host component provides a hidden keyboard route into the mindmap.
10. Whether imported/manual positions remain visually stable after all measurement passes on complex documents.
11. Whether missing image assets should produce an explicit user-facing error, a placeholder, or a silent empty slot.

## Final checklist: what an R-node user can do that is not available today

A user who knows R-node cannot currently rely on Thoughtslibrary to:

- build and navigate a map with Enter/Tab/arrows/Space/Delete;
- type immediately into the selected node;
- select multiple topics or draw a selection rectangle;
- drag a topic before/after/under another topic;
- create floating topics from the canvas;
- duplicate, promote, demote, or create a parent through the normal workflow;
- edit part of a title as bold/italic/underline/strike/color;
- create headings, paragraphs, or nested bullet lists inside a title;
- paste structured HTML from Word/Google Docs/Draw.io;
- copy, cut, and paste a subtree or an indented outline;
- use R-node's relationship, group, summary, task, label, or marker interactions;
- drop or paste an image directly onto a node;
- use multiple image slots, select/move an embedded image, or resize it from the canvas;
- save/open a mindmap as an `.rnode` document or `.rnode.zip`;
- export the mindmap itself as SVG, standalone HTML, or a verified image/PDF artifact;
- see explicit Saved/Unsaved status for the mindmap;
- depend on R-node's documented image memory strategy for very large maps.

Conversely, Thoughtslibrary already gives the user an equivalent basic rooted map layout, visible-node culling, cursor-anchored zoom, local image persistence, DOM-based measurement, single-node selection, create child/sibling, delete subtree, collapse, style inspection, and operation-based undo/redo. Those should be preserved as completed or equivalent capabilities while the missing behavioral workflows are implemented.
