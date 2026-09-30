# Worker prezzi ShopAdvisor

Il worker aggiorna ogni giorno alle **03:00** (`Europe/Rome`) i tre ASIN configurati per Amazon Italia, Francia e Germania. I prezzi francesi e tedeschi vengono convertiti dal prezzo IVA inclusa locale al prezzo con IVA italiana al 22% prima della scrittura nel database.

## Configurazione

1. Copia `.env.example` in `.env` nella cartella `worker`.
2. Inserisci `RAINFOREST_API_KEY` e `SERPAPI_API_KEY` nel nuovo file `.env`.

Il provider viene scelto per restare nei limiti gratuiti: Rainforest nei primi cinque giorni del mese (45 richieste) e SerpApi nei giorni restanti (massimo 234 richieste). Ogni esecuzione usa nove richieste: tre ASIN per tre mercati.

## Avvio

Dalla cartella `Progetto`:

```bash
docker compose up -d --build product-worker
```

Per un aggiornamento manuale, una sola volta:

```bash
docker compose run --rm product-worker npm run refresh
```

Per forzare un provider durante un test:

```bash
docker compose run --rm product-worker npm run refresh -- --provider=rainforest
```

Per aggiornare un solo prodotto, aggiungi `--asin=<ASIN>`. Se uno o più mercati non rispondono, il worker salva comunque i dati disponibili e non sovrascrive quelli esistenti per i mercati mancanti.

Controlla il servizio con `docker compose logs -f product-worker` e fermalo con `docker compose stop product-worker`.
