// updater.ts
import { PrismaClient } from "@prisma/client";
import { NormalizedProduct, WorkerResult, AmazonMarket } from "./types";
import * as path from "path";
const { PrismaClient } = require(path.resolve(__dirname, "../../shop-advisor/node_modules/@prisma/client"));

interface ResultEntry {
    data: NormalizedProduct;
    timestamp: Date;
}

interface PendingAsinState {
    asin: string;
    cycleIndex: number;
    results: Map<string, ResultEntry>;
    failedMarkets: Set<string>;
    expectedMarkets: Set<string>;
}

export interface PriceSnapshot {
    price: number;
    shipping: number;
    timestamp: string;
}

export class ProductUpdater {
    private prisma: PrismaClient;
    // Chiave univoca: `${asin}_cycle_${cycleIndex}`
    private pendingUpdates: Map<string, PendingAsinState> = new Map();

    private readonly VAT_RATES: Record<string, number> = {
        "amazon.it": 0.22,
        "amazon.fr": 0.20,
        "amazon.de": 0.19,
    };
    private readonly TARGET_VAT = 0.22;

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
    }

    private getKey(asin: string, cycleIndex: number = 0): string {
        return `${asin}_cycle_${cycleIndex}`;
    }

    public registerExpectation(asin: string, markets: AmazonMarket[], cycleIndex: number = 0): void {
        const key = this.getKey(asin, cycleIndex);
        if (!this.pendingUpdates.has(key)) {
            this.pendingUpdates.set(key, {
                asin,
                cycleIndex,
                results: new Map(),
                failedMarkets: new Set(),
                expectedMarkets: new Set(markets)
            });
        }
    }

    public async submitResult(asin: string, market: string, result: WorkerResult, cycleIndex: number = 0): Promise<void> {
        const key = this.getKey(asin, cycleIndex);
        const entry = this.pendingUpdates.get(key);
        if (!entry) return;

        if (result.success && result.data) {
            entry.results.set(market, { data: result.data, timestamp: result.timestamp });
        } else {
            entry.failedMarkets.add(market);
        }

        const isComplete = (entry.results.size + entry.failedMarkets.size) === entry.expectedMarkets.size;

        if (isComplete) {
            this.pendingUpdates.delete(key);

            if (entry.results.size === 0) {
                console.warn(`[Updater] ❌ Ciclo ${cycleIndex} per ${asin} fallito su tutti i mercati previsti.`);
                await this.markDeferredAsins([asin]);
                return;
            }

            await this.commitProductUpdate(asin, Array.from(entry.results.values()));
        }
    }

    private calculateLandedCost(product: NormalizedProduct): number | null {
        if (product.price === null) return null;

        const localVat = this.VAT_RATES[product.market] || this.TARGET_VAT;
        const priceWithoutVat = product.price / (1 + localVat);
        const normalizedPrice = priceWithoutVat * (1 + this.TARGET_VAT);
        const shipping = product.shippingCost ?? 0;
        
        return Math.round((normalizedPrice + shipping) * 100) / 100;
    }

    private async commitProductUpdate(asin: string, entries: ResultEntry[]): Promise<void> {
        const itEntry = entries.find(e => e.data.market === "amazon.it");
        const frEntry = entries.find(e => e.data.market === "amazon.fr");
        const deEntry = entries.find(e => e.data.market === "amazon.de");

        const currentProduct = await this.prisma.product.findUnique({
            where: { asin },
            select: { 
                id: true,
                currentPriceIT: true, currentPriceFR: true, currentPriceDE: true,
                historyIT: true, historyFR: true, historyDE: true,
                priorityCode: true, unchangedCount: true,
                _count: { select: { alerts: { where: { isActive: true } } } }
            }
        });

        if (!currentProduct) {
            console.error(`[Updater] Prodotto ${asin} non trovato nel DB.`);
            return;
        }

        const itLandedCost = itEntry ? this.calculateLandedCost(itEntry.data) : undefined;
        const frLandedCost = frEntry ? this.calculateLandedCost(frEntry.data) : undefined;
        const deLandedCost = deEntry ? this.calculateLandedCost(deEntry.data) : undefined;

        // Verifica variazioni di prezzo
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
            console.log(`[Updater] 🚀 Promozione per ${asin}! Priorità: ${newPriority}`);
        } else {
            newUnchangedCount += 1;
            if (newUnchangedCount >= 3) {
                newPriority = Math.min(maxDemotion, currentProduct.priorityCode + 1);
                newUnchangedCount = 0; 
                console.log(`[Updater] 📉 Declassamento per ${asin}. Priorità: ${newPriority}`);
            }
        }

        const appendHistory = (currentHistory: unknown, entry?: ResultEntry, landedCost?: number | null): PriceSnapshot[] => {
            const list = Array.isArray(currentHistory) ? (currentHistory as PriceSnapshot[]) : [];
            if (!entry || landedCost === null || landedCost === undefined) return list;
            
            return [...list, { 
                price: landedCost, 
                shipping: entry.data.shippingCost ?? 0, 
                timestamp: entry.timestamp.toISOString() 
            }];
        };

        // Aggiornamento atomico nel database
        await this.prisma.product.update({
            where: { asin },
            data: {
                currentPriceIT: itLandedCost !== undefined ? itLandedCost : currentProduct.currentPriceIT,
                shippingIT: itEntry !== undefined ? itEntry.data.shippingCost : undefined,
                historyIT: appendHistory(currentProduct.historyIT, itEntry, itLandedCost) as any,

                currentPriceFR: frLandedCost !== undefined ? frLandedCost : currentProduct.currentPriceFR,
                shippingFR: frEntry !== undefined ? frEntry.data.shippingCost : undefined,
                historyFR: appendHistory(currentProduct.historyFR, frEntry, frLandedCost) as any,

                currentPriceDE: deLandedCost !== undefined ? deLandedCost : currentProduct.currentPriceDE,
                shippingDE: deEntry !== undefined ? deEntry.data.shippingCost : undefined,
                historyDE: appendHistory(currentProduct.historyDE, deEntry, deLandedCost) as any,

                priorityCode: newPriority,
                unchangedCount: newUnchangedCount,
                mustTomorrow: false, 
                lastUpdated: new Date()
            }
        });

        console.log(`[Updater] ✅ ASIN ${asin} consolidato nel database.`);

        // Controllo Trigger Alert Utenti se il prezzo migliore tra i 3 mercati scende
        const validPrices = [itLandedCost, frLandedCost, deLandedCost].filter((p): p is number => typeof p === 'number');
        if (validPrices.length > 0) {
            const bestCurrentPrice = Math.min(...validPrices);
            await this.checkAndTriggerAlerts(currentProduct.id, asin, bestCurrentPrice);
        }
    }

    private async checkAndTriggerAlerts(productId: string, asin: string, lowestPrice: number): Promise<void> {
        try {
            const triggeredAlerts = await this.prisma.alert.findMany({
                where: {
                    productId,
                    isActive: true,
                    targetPrice: { gte: lowestPrice }
                },
                include: { user: true }
            });

            for (const alert of triggeredAlerts) {
                console.log(`[ALERT TRIGGERED] 🔔 Utente ${alert.user.telegramId} per ASIN ${asin}: Prezzo ${lowestPrice}€ <= Target ${alert.targetPrice}€`);
            }
        } catch (e: any) {
            console.error(`[Updater] Errore verifica alerts per ${asin}:`, e.message);
        }
    }

    public async markDeferredAsins(asins: string[]): Promise<void> {
        if (asins.length === 0) return;
        await this.prisma.product.updateMany({
            where: { asin: { in: asins } },
            data: { mustTomorrow: true }
        });
    }

    public async flushPartialUpdates(): Promise<void> {
        for (const [_, state] of this.pendingUpdates.entries()) {
            if (state.results.size > 0) {
                await this.commitProductUpdate(state.asin, Array.from(state.results.values()));
            }
        }
        this.pendingUpdates.clear();
    }
}