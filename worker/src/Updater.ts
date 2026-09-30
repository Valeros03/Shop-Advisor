// updater.ts
import { PrismaClient } from "@prisma/client";
import { NormalizedProduct, WorkerResult, AmazonMarket } from "./types";

interface ResultEntry {
    data: NormalizedProduct;
    timestamp: Date; // Fondamentale per mantenere l'orario effettivo del worker
}

interface PendingAsinState {
    results: Map<string, ResultEntry>;
    failedMarkets: Set<string>;
    expectedMarkets: Set<string>;
}

interface PriceSnapshot {
    price: number;
    shipping: number;
    timestamp: string;
}

export class ProductUpdater {
    private prisma: PrismaClient;
    private pendingUpdates: Map<string, PendingAsinState> = new Map();

    // Costanti per normalizzazione fiscale (IVA)
    private readonly VAT_RATES: Record<string, number> = {
        "amazon.it": 0.22,
        "amazon.fr": 0.20,
        "amazon.de": 0.19,
    };
    private readonly TARGET_VAT = 0.22; // IVA Italiana per il Landed Cost

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
    }

    public registerExpectation(asin: string, markets: AmazonMarket[]): void {
        if (!this.pendingUpdates.has(asin)) {
            this.pendingUpdates.set(asin, {
                results: new Map(),
                failedMarkets: new Set(),
                expectedMarkets: new Set(markets)
            });
        }
    }

    public async submitResult(asin: string, market: string, result: WorkerResult): Promise<void> {
        const entry = this.pendingUpdates.get(asin);
        if (!entry) return;

        if (result.success && result.data) {
            // Salviamo non solo il dato, ma l'orario esatto della fetch
            entry.results.set(market, { data: result.data, timestamp: result.timestamp });
        } else {
            entry.failedMarkets.add(market);
        }

        const isComplete = (entry.results.size + entry.failedMarkets.size) === entry.expectedMarkets.size;

        if (isComplete) {
            this.pendingUpdates.delete(asin); // Libera la RAM istantaneamente

            if (entry.results.size === 0) {
                console.warn(`[Updater] ❌ Update cancellato per ${asin}: fallimento totale su tutti i mercati previsti.`);
                await this.markDeferredAsins([asin]);
                return;
            }

            // Flush sul DB atomico
            await this.commitProductUpdate(asin, Array.from(entry.results.values()));
        }
    }

    // --- NORMALIZZAZIONE FISCALE ---
    private calculateLandedCost(product: NormalizedProduct): number | null {
        if (product.price === null) return null;

        const localVat = this.VAT_RATES[product.market] || this.TARGET_VAT;
        
        // 1. Scorporo IVA locale
        const priceWithoutVat = product.price / (1 + localVat);
        // 2. Applico IVA Italiana
        const normalizedPrice = priceWithoutVat * (1 + this.TARGET_VAT);
        // 3. Sommo la spedizione
        const shipping = product.shippingCost ?? 0;
        
        const landedCost = normalizedPrice + shipping;
        return Math.round(landedCost * 100) / 100; // Arrotondamento a 2 decimali
    }

    private async commitProductUpdate(asin: string, entries: ResultEntry[]): Promise<void> {
        const itEntry = entries.find(e => e.data.market === "amazon.it");
        const frEntry = entries.find(e => e.data.market === "amazon.fr");
        const deEntry = entries.find(e => e.data.market === "amazon.de");

        const currentProduct = await this.prisma.product.findUnique({
            where: { asin },
            select: { 
                currentPriceIT: true, currentPriceFR: true, currentPriceDE: true,
                historyIT: true, historyFR: true, historyDE: true,
                priorityCode: true, unchangedCount: true,
                _count: { select: { alerts: { where: { isActive: true } } } }
            }
        });

        if (!currentProduct) {
            console.error(`[Updater] Prodotto ${asin} non trovato nel DB. Impossibile aggiornare.`);
            return;
        }

        // Calcoliamo i costi finali per l'utente italiano
        const itLandedCost = itEntry ? this.calculateLandedCost(itEntry.data) : undefined;
        const frLandedCost = frEntry ? this.calculateLandedCost(frEntry.data) : undefined;
        const deLandedCost = deEntry ? this.calculateLandedCost(deEntry.data) : undefined;

        // --- 1. LOGICA PROMOTORE / PUNITORE SUL PREZZO FINALE ---
        const changedIT = itLandedCost !== undefined && itLandedCost !== currentProduct.currentPriceIT;
        const changedFR = frLandedCost !== undefined && frLandedCost !== currentProduct.currentPriceFR;
        const changedDE = deLandedCost !== undefined && deLandedCost !== currentProduct.currentPriceDE;
        
        const isPriceChanged = changedIT || changedFR || changedDE;

        let newPriority = currentProduct.priorityCode;
        let newUnchangedCount = currentProduct.unchangedCount;

        const isTrackedByUser = currentProduct._count.alerts > 0;
        const maxDemotion = isTrackedByUser ? 3 : 7; 

        if (isPriceChanged) {
            newPriority = Math.max(1, currentProduct.priorityCode - 1);
            newUnchangedCount = 0;
            console.log(`[Updater] 🚀 Promozione per ${asin}! Nuova priorità: ${newPriority}`);
        } else {
            newUnchangedCount += 1;
            if (newUnchangedCount >= 3) {
                newPriority = Math.min(maxDemotion, currentProduct.priorityCode + 1);
                newUnchangedCount = 0; 
                console.log(`[Updater] 📉 Declassamento per ${asin}. Nuova priorità: ${newPriority}`);
            }
        }

        // --- 2. GESTIONE STORICO CON TIMESTAMP ESATTI ---
        const appendHistory = (currentHistory: unknown, entry?: ResultEntry, landedCost?: number | null): PriceSnapshot[] => {
            const list = Array.isArray(currentHistory) ? (currentHistory as PriceSnapshot[]) : [];
            
            // Se l'operazione non c'è, o il prodotto è out of stock (null), non inquiniamo il grafico
            if (!entry || landedCost === null || landedCost === undefined) return list;
            
            return [...list, { 
                price: landedCost, 
                shipping: entry.data.shippingCost ?? 0, 
                // Usiamo il momento esatto in cui l'API o lo Scraper ha estratto il dato
                timestamp: entry.timestamp.toISOString() 
            }];
        };

        // --- 3. SCRITTURA ATOMICA NEL DATABASE ---
        await this.prisma.product.update({
            where: { asin },
            data: {
                currentPriceIT: itLandedCost !== undefined ? itLandedCost : currentProduct.currentPriceIT,
                shippingIT: itEntry !== undefined ? itEntry.data.shippingCost : undefined,
                historyIT: JSON.stringify(appendHistory(currentProduct.historyIT, itEntry, itLandedCost)),

                currentPriceFR: frLandedCost !== undefined ? frLandedCost : currentProduct.currentPriceFR,
                shippingFR: frEntry !== undefined ? frEntry.data.shippingCost : undefined,
                historyFR: JSON.stringify(appendHistory(currentProduct.historyFR, frEntry, frLandedCost)),

                currentPriceDE: deLandedCost !== undefined ? deLandedCost : currentProduct.currentPriceDE,
                shippingDE: deEntry !== undefined ? deEntry.data.shippingCost : undefined,
                historyDE: JSON.stringify(appendHistory(currentProduct.historyDE, deEntry, deLandedCost)),

                priorityCode: newPriority,
                unchangedCount: newUnchangedCount,
                mustTomorrow: false, 
                lastUpdated: new Date() // La data in cui il ciclo è stato chiuso e salvato su DB
            }
        });

        console.log(`[Updater] ✅ ASIN ${asin} consolidato e aggiornato su DB.`);
    }

    public async markDeferredAsins(asins: string[]): Promise<void> {
        if (asins.length === 0) return;
        await this.prisma.product.updateMany({
            where: { asin: { in: asins } },
            data: { mustTomorrow: true }
        });
    }

    public async flushPartialUpdates(): Promise<void> {
        for (const [asin, state] of this.pendingUpdates.entries()) {
            if (state.results.size > 0) {
                await this.commitProductUpdate(asin, Array.from(state.results.values()));
            }
        }
        this.pendingUpdates.clear();
    }
}