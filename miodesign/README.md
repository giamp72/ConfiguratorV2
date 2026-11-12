# MIO Design — ConfiguratorV2

Applicazione web statica per la configurazione dei prodotti, con Supabase Auth,
database e archivio GLB privato. Il client Supabase è caricato da esm.sh;
Three.js è incluso in `vendor/`.

## Installazione

1. Crea un **nuovo** progetto Supabase ed esegui nello SQL Editor, nell'ordine,
   `supabase/schema.sql` e `supabase/assembly.sql`. Gli script creano anche le
   policy RLS e il bucket privato `modelli-glb`. Le policy consentono l'accesso
   in lettura e scrittura a tutti gli utenti autenticati, senza ruoli distinti.
   Gli script non migrano i dati della versione precedente.
2. Crea gli utenti in *Authentication > Users*. `config.js` contiene l'URL del
   progetto e la chiave pubblica Supabase (publishable); se rigeneri la chiave,
   aggiornala lì. Non inserire chiavi secret o service role: il file è caricato
   dal browser.
3. Dalla radice del repository esegui `python3 -m http.server 4174` e visita
   `http://localhost:4174/`. Per caricare il client Supabase serve accesso a esm.sh.

## Flusso

- Parti da **Prodotti**: crea il prodotto, definisci le misure e associa attributi
  esistenti oppure creane di nuovi dalla scheda. Scegli opzioni ammesse, default,
  ordine, obbligatorietà e flag di codifica.
- Gli attributi sono di tipo **Materiale** o **Visibilità**. Il GLB del materiale
  è associato direttamente all'opzione; non esiste una tabella materiali.
  Attributi derivati possono esporre un sottoinsieme delle opzioni del padre.
  Nella scheda attributo, **Anteprima** mostra il materiale su una sfera;
  il GLB deve contenere almeno una mesh con materiale.
- Per ogni misura si possono caricare o riutilizzare più GLB come componenti,
  anche più istanze dello stesso GLB. Ogni istanza ha posizione X/Y/Z in metri
  e rotazione Euler XYZ in gradi; le mappature mesh-attributo sono distinte per
  componente. L'assemblaggio viene visualizzato sia nella scheda prodotto sia
  nel Final Check.
- Le condizioni sono specifiche del prodotto: più condizioni attive sulla stessa
  destinazione si intersecano; sono ammesse catene ma non cicli. Anche gli
  attributi non codificati condizionano le combinazioni commerciali valide.
- **Codifica e Pricing** consente di assegnare codice, descrizione e prezzi per
  listino alle combinazioni valide di misura e attributi codificati, fino a
  5000 combinazioni per prodotto. **Final Check** mostra risultato commerciale
  e anteprima e permette di segnare il prodotto come testato.

Il salvataggio della scheda prodotto comprende più operazioni sul database, non
un'unica transazione: in caso di errore, ricarica e verifica i dati prima di
riprovare. Le condizioni non cancellano codici e prezzi precedenti: le combinazioni non
più ammesse vengono nascoste e riappaiono se tornano valide. I GLB non più
associati possono rimanere nell'archivio e richiedere pulizia amministrativa.

## Test

Da radice: `node --test miodesign/tests/*.test.mjs`. È richiesto Node.js.
I test SQL in `tests/assembly-schema.sql` e `tests/material-options-schema.sql`
richiedono un database di prova già inizializzato con entrambi gli script di
installazione; usare `psql -v ON_ERROR_STOP=1 -f <file>`. Eseguirli solo su un
database sacrificabile: le transazioni vengono annullate ma le sequenze avanzano.
