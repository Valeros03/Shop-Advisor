// updater.ts
import { PrismaClient } from "@prisma/client";
import { NormalizedProduct, WorkerResult, AmazonMarket } from "./types";
import * as path from "path";
import { telegramNotifier } from "./service/TelegramNotificationService";

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

    private getItalianOperationalStart(now = new Date()): Date {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Rome',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hour12: false
        }).formatToParts(now);

        const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
        const hour = get('hour');
        const isDST = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'short' })
            .formatToParts(now).find(p => p.type === 'timeZoneName')?.value === 'GMT+2';
        const offset = isDST ? '+02:00' : '+01:00';
        const pad = (n: number) => String(n).padStart(2, '0');

        const today7AM = new Date(`${parts.find(p => p.type === 'year')!.value}-${pad(get('month'))}-${pad(get('day'))}T07:00:00${offset}`);

        // Se chiamata tra le 00:00 e le 06:59, il turno di riferimento è iniziato ieri alle 07:00
        if (hour < 7) {
            return new Date(today7AM.getTime() - 24 * 3600 * 1000);
        }
        return today7AM;
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

    public cancelPendingTask(asin: string, market: string, cycleIndex: number = 0): void {
        const key = this.getKey(asin, cycleIndex);
        const entry = this.pendingUpdates.get(key);
        if (entry) {
            entry.failedMarkets.add(market);
        }
    }

    private calculateLandedCost(product: NormalizedProduct): number | null {
        // Se price è null (prodotto non disponibile/dirottato), il costo a terra è null
        if (product.price === null) return null;

        if (product.market === "amazon.it") {
            const shipping = product.shippingCost ?? 0;
            return Math.round((product.price + shipping) * 100) / 100;
        }

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
                name: true,
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

        // Log espliciti di non disponibilità
        if (itLandedCost === null) console.log(`[Updater] ℹ️ ASIN ${asin} non disponibile su amazon.it (prezzo -> null)`);
        if (frLandedCost === null) console.log(`[Updater] ℹ️ ASIN ${asin} non disponibile su amazon.fr (prezzo -> null)`);
        if (deLandedCost === null) console.log(`[Updater] ℹ️ ASIN ${asin} non disponibile su amazon.de (prezzo -> null)`);

        const changedIT = itLandedCost !== undefined && itLandedCost !== currentProduct.currentPriceIT;
        const changedFR = frLandedCost !== undefined && frLandedCost !== currentProduct.currentPriceFR;
        const changedDE = deLandedCost !== undefined && deLandedCost !== currentProduct.currentPriceDE;
        const isPriceChanged = changedIT || changedFR || changedDE;

        let newPriority = currentProduct.priorityCode;
        let newUnchangedCount = currentProduct.unchangedCount;
        const isTrackedByUser = currentProduct._count.alerts > 0;
        const maxDemotion = isTrackedByUser ? 3 : 7;

        if (isPriceChanged) {
            newUnchangedCount = 0;
            if (isTrackedByUser) {
                newPriority = Math.max(1, currentProduct.priorityCode - 1);
            } else {
                newPriority = Math.max(3, currentProduct.priorityCode - 1);
            }
        } else {
            newUnchangedCount += 1;
            if (newUnchangedCount >= 3) {
                newPriority = Math.min(maxDemotion, currentProduct.priorityCode + 1);
                newUnchangedCount = 0; 
            }
        }

        const appendHistory = (currentHistory: unknown, entry?: ResultEntry, landedCost?: number | null): PriceSnapshot[] => {
            const list = Array.isArray(currentHistory) ? (currentHistory as PriceSnapshot[]) : [];
            // Non aggiunge snapshot se il prodotto è esaurito/null
            if (!entry || landedCost === null || landedCost === undefined) return list;
            
            return [...list, { 
                price: landedCost, 
                shipping: entry.data.shippingCost ?? 0, 
                timestamp: entry.timestamp.toISOString() 
            }];
        };

        // Salvataggio nel database: se itLandedCost è null, sovrascrive a null
        await this.prisma.product.update({
            where: { asin },
            data: {
                currentPriceIT: itLandedCost !== undefined ? itLandedCost : currentProduct.currentPriceIT,
                shippingIT: itEntry !== undefined ? (itEntry.data.price === null ? null : itEntry.data.shippingCost) : undefined,
                historyIT: appendHistory(currentProduct.historyIT, itEntry, itLandedCost) as any,

                currentPriceFR: frLandedCost !== undefined ? frLandedCost : currentProduct.currentPriceFR,
                shippingFR: frEntry !== undefined ? (frEntry.data.price === null ? null : frEntry.data.shippingCost) : undefined,
                historyFR: appendHistory(currentProduct.historyFR, frEntry, frLandedCost) as any,

                currentPriceDE: deLandedCost !== undefined ? deLandedCost : currentProduct.currentPriceDE,
                shippingDE: deEntry !== undefined ? (deEntry.data.price === null ? null : deEntry.data.shippingCost) : undefined,
                historyDE: appendHistory(currentProduct.historyDE, deEntry, deLandedCost) as any,

                priorityCode: newPriority,
                unchangedCount: newUnchangedCount,
                mustTomorrow: false, 
                lastUpdated: new Date()
            }
        });

        console.log(`[Updater] ASIN ${asin} consolidato nel database.`);

        // Filtra solo i mercati con un prezzo positivo valido per non inviare falsi allarmi
        const marketPrices: { market: string; price: number }[] = [];
        const finalIT = itLandedCost !== undefined ? itLandedCost : currentProduct.currentPriceIT;
        const finalFR = frLandedCost !== undefined ? frLandedCost : currentProduct.currentPriceFR;
        const finalDE = deLandedCost !== undefined ? deLandedCost : currentProduct.currentPriceDE;

        if (typeof finalIT === 'number' && finalIT > 0) marketPrices.push({ market: 'amazon.it', price: finalIT });
        if (typeof finalFR === 'number' && finalFR > 0) marketPrices.push({ market: 'amazon.fr', price: finalFR });
        if (typeof finalDE === 'number' && finalDE > 0) marketPrices.push({ market: 'amazon.de', price: finalDE });

        if (marketPrices.length > 0) {
            await this.checkAndTriggerAlerts(
                currentProduct.id, 
                asin, 
                currentProduct.name || `Prodotto ${asin}`, 
                currentProduct.image,
                marketPrices
            );
        }
    }

    private async checkAndTriggerAlerts(
        productId: string, 
        asin: string, 
        productName: string, 
        imageUrl: string,
        marketPrices: { market: string; price: number }[]
    ): Promise<void> {
        try {
            const absoluteLowest = Math.min(...marketPrices.map(m => m.price));

            const triggeredAlerts = await this.prisma.alert.findMany({
                where: {
                    productId,
                    isActive: true,
                    targetPrice: { gte: absoluteLowest }
                },
                include: { user: true }
            });

            if (triggeredAlerts.length === 0) return;

            for (const alert of triggeredAlerts) {
                const qualifying = marketPrices.filter(m => m.price <= alert.targetPrice);
                if (qualifying.length === 0) continue;

                qualifying.sort((a, b) => a.price - b.price);
                const bestMarketEntry = qualifying[0];
                const currentBestPrice = bestMarketEntry.price;

                const hasPriceChanged = alert.lastNotifiedPrice === null || alert.lastNotifiedPrice === undefined || currentBestPrice < alert.lastNotifiedPrice;

                if (!hasPriceChanged) continue;

                const telegramIdStr = alert.user.telegramId.toString();

                const result = await telegramNotifier.sendPriceAlert({
                    telegramId: telegramIdStr,
                    productName: productName,
                    asin: asin,
                    targetPrice: alert.targetPrice,
                    bestPrice: currentBestPrice,
                    bestMarket: bestMarketEntry.market,
                    qualifyingMarkets: qualifying,
                    imageUrl: imageUrl
                });

                if (result === "SENT") {
                    console.log(`[Updater] Alert notificato a Telegram per utente ${alert.userId} su ASIN ${asin} (Nuovo prezzo: ${currentBestPrice}€)`);
                    await this.prisma.alert.update({
                        where: { id: alert.id },
                        data: {
                            lastNotifiedPrice: currentBestPrice,
                            isActive: true
                        }
                    });
                } else if (result === "BLOCKED") {
                    console.log(`[Updater] Disattivo gli alert per l'utente ${alert.userId} (bot bloccato su Telegram).`);
                    await this.prisma.alert.updateMany({
                        where: { userId: alert.userId },
                        data: { isActive: false }
                    });
                }

                await new Promise(resolve => setTimeout(resolve, 60));
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
        console.log(`[Updater] Consolidamento finale richieste parziali (${this.pendingUpdates.size} in sospeso)...`);
        
        const incompleteAsins = new Set<string>();

        for (const [key, state] of this.pendingUpdates.entries()) {
            if (state.results.size > 0) {
                await this.commitProductUpdate(state.asin, Array.from(state.results.values()));
            } else {
                incompleteAsins.add(state.asin);
            }
        }
        this.pendingUpdates.clear();

        if (incompleteAsins.size > 0) {
            // Calcola le 07:00 del turno operativo appena concluso
            const operationalStart = this.getItalianOperationalStart(new Date());

            // Seleziona solo i prodotti che NON sono mai stati aggiornati durante l'intero turno (dalle 07:00 a mezzanotte)
            const productsWithoutTodayUpdate = await this.prisma.product.findMany({
                where: {
                    asin: { in: Array.from(incompleteAsins) },
                    OR: [
                        { lastUpdated: null },
                        { lastUpdated: { lt: operationalStart } }
                    ]
                },
                select: { asin: true }
            });

            const asinsToFlag = productsWithoutTodayUpdate.map(p => p.asin);
            if (asinsToFlag.length > 0) {
                console.warn(`[Updater] ${asinsToFlag.length} prodotti privi di aggiornamenti odierni segnati con mustTomorrow: true`);
                await this.markDeferredAsins(asinsToFlag);
            }
        }
    }
}