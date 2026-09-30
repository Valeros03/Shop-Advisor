import { BaseWorker } from "../worker";
import { Task, WorkerResult, WorkerLimits, AmazonMarket } from "../types";
import * as cheerio from "cheerio";
import { gotScraping } from "got-scraping";
// @ts-ignore
// @ts-ignore
import { CookieJar } from "tough-cookie";
import { notifier } from "../service/NotificationService";
import { ProductUpdater } from "../Updater";

interface PartialCluster {
    asin: string;
    tasks: Task[]; 
}

interface ScheduledCluster {
    targetTime: number; 
    cluster: PartialCluster;
}

export class CustomScraperWorker extends BaseWorker {
    public readonly priorityCost = 99; // Costo alto: ultima spiaggia per il Dispatcher
    private virtualSeconds: number = 0;
    
    private cookieJar: CookieJar;
    private longPausesDone: number = 0;
    private timelineQueue: ScheduledCluster[] = [];

    constructor(
        name: string, 
        limits: WorkerLimits, 
        supportedMarkets: AmazonMarket[], 
        initialUsage = { daily: 0, monthly: 0, lifetime: 0 }
    ) {
        super(name, 'scraper', limits, supportedMarkets, initialUsage);
        this.cookieJar = new CookieJar();
    }

    // =====================================================================
    // LIVELLO 2: SIMULAZIONE VIRTUALE (La matematica corretta)
    // =====================================================================
    
    public getRawCurrency(): number {
        // 17 ore di giornata attiva (07:00 - 00:00) = 61.200 secondi
        const totalActiveSeconds = 17 * 3600;
        
        // Sottraiamo SUBITO il worst-case delle Pause Lunghe (2 pause da max 60 min = 7200s)
        const longPausesSeconds = 120 * 60;
        return totalActiveSeconds - longPausesSeconds;
    }

    public setupVirtualSimulation(): void {
        this.virtualSeconds = this.getRawCurrency();
    }

    public consumeVirtualCurrency(isFirstTaskForAsin: boolean): boolean {
        // Valori medi esatti basati sui limiti randomici imposti
        const MACRO_PAUSE_AVG = 82.5;  // (45 + 120) / 2
        const MICRO_PAUSE_AVG = 8.25;  // (1.5 + 15) / 2
        const NETWORK_FETCH_AVG = 7.0; // Stima tempo di rete
        
        let costSeconds = 0;

        if (isFirstTaskForAsin) {
            // È il primo mercato per questo ASIN: costa la Macro-Pausa + Rete
            costSeconds = MACRO_PAUSE_AVG + NETWORK_FETCH_AVG; // ~89.5s
        } else {
            // Mercati successivi dello stesso ASIN: costa solo la Micro-Pausa (Cambio Tab) + Rete
            costSeconds = MICRO_PAUSE_AVG + NETWORK_FETCH_AVG; // ~15.25s
        }

        if (this.virtualSeconds >= costSeconds) {
            this.virtualSeconds -= costSeconds;
            return true;
        }
        return false;
    }

    // =====================================================================
    // LIVELLO 3.A: DELEGAZIONE E TIME-BUCKETING
    // =====================================================================
    public delegateAndOrganizeTasks(rawTasks: Task[]): void {
        console.log(`[Scraper - ${this.name}] Ricompattazione dei ${rawTasks.length} task frammentati...`);
        
        const clustersByAsin = new Map<string, PartialCluster[]>();

        for (const task of rawTasks) {
            if (!clustersByAsin.has(task.asin)) clustersByAsin.set(task.asin, []);
            const asinClusters = clustersByAsin.get(task.asin)!;

            let targetCluster = asinClusters.find(c => !c.tasks.some(t => t.market === task.market));

            if (!targetCluster) {
                targetCluster = { asin: task.asin, tasks: [] };
                asinClusters.push(targetCluster);
            }
            targetCluster.tasks.push(task);
        }

        const now = Date.now();
        const midnight = new Date();
        midnight.setHours(23, 59, 59, 999);
        const totalWindowMs = midnight.getTime() - now;

        this.timelineQueue = [];

        for (const [asin, clusters] of clustersByAsin.entries()) {
            const bucketSizeMs = totalWindowMs / clusters.length;

            clusters.forEach((cluster, index) => {
                // Jitter randomico (es. 40%) per variare l'orario di target ed evitare ritmi artificiali
                const jitter = Math.random() * (bucketSizeMs * 0.4);
                const targetTime = now + (index * bucketSizeMs) + jitter;
                this.timelineQueue.push({ targetTime, cluster });
            });
        }

        // Mette in fila cronologica tutti gli ASIN da scansionare
        this.timelineQueue.sort((a, b) => a.targetTime - b.targetTime);
    }

    // =====================================================================
    // LIVELLO 3.C/D/E: ESECUZIONE DELLA TIMELINE (Pacing e Limiti Tassativi)
    // =====================================================================
    public async executeDailyMission(updater: ProductUpdater): Promise<void> {
        while (this.timelineQueue.length > 0) {
            const scheduledJob = this.timelineQueue.shift()!;
            
            // 1. Pausa Lunga Organica (30-60min, 1-2 volte al giorno, asincrona)
            await this.handleLongPauses();

            // 2. PAUSA TRA ASIN (Macro-Pausa)
            const now = Date.now();
            const msUntilTarget = scheduledJob.targetTime - now;

            // Genera la pausa organica puramente randomica per QUESTO ciclo (sempre tra 45 e 120 sec)
            const minPauseMs = 45000;
            const maxPauseMs = 120000;
            const organicPauseMs = Math.floor(Math.random() * (maxPauseMs - minPauseMs + 1)) + minPauseMs;

            // L'orologio spaziatore: 
            // Se siamo molto in anticipo sulla tabella di marcia, aspettiamo il targetTime (es. 2 ore).
            // Se siamo in ritardo o in fase di elaborazione attiva, usiamo la pausa organica umana.
            const waitTimeMs = Math.max(organicPauseMs, msUntilTarget);

            console.log(`[Scraper - ${this.name}] ⏰ Cambio ASIN. Attesa ricalcolata: ${Math.round(waitTimeMs / 1000)}s...`);
            await this.sleep(waitTimeMs / 1000);

            // 3. ESECUZIONE RICERCHE E MICRO-PAUSE (Stesso ASIN)
            for (let i = 0; i < scheduledJob.cluster.tasks.length; i++) {
                const task = scheduledJob.cluster.tasks[i];
                
                const result = await this.scrapeSingleMarket(task);
                await updater.submitResult(task.asin, task.market, result);

                // REGOLA TASSATIVA SULLE MICRO-PAUSE: 1.5s - 15s randomici per ogni singola tab
                if (i < scheduledJob.cluster.tasks.length - 1) {
                    const microPause = (Math.random() * 13.5) + 1.5;
                    console.log(`[Scraper - ${this.name}] 🔎 Savvy Shopper: Micro-Pausa di ${microPause.toFixed(1)}s prima dell'altra tab...`);
                    await this.sleep(microPause);
                }
            }
        }
        console.log(`[Scraper - ${this.name}] 🏁 Missione completata.`);
    }

    private async handleLongPauses(): Promise<void> {
        const hour = new Date().getHours();
        
        if (hour >= 0 && hour < 7) {
            console.log(`[Scraper - ${this.name}] 🌙 Sospensione notturna. Attesa fino al mattino...`);
            await this.sleep(3600);
            return this.handleLongPauses();
        }

        // Tassativa: 1 o 2 pause lunghe, random tra 30-60m
        if (this.longPausesDone < 2 && hour >= 11 && hour <= 21 && Math.random() < 0.05) {
            const pausaMinuti = Math.floor(Math.random() * 31) + 30; // random tra 30 e 60
            console.log(`[Scraper - ${this.name}] 🍽️ Avvio pausa lunga di ${pausaMinuti} min...`);
            this.longPausesDone++;
            await this.sleep(pausaMinuti * 60);
        }
    }

    // =====================================================================
    // CORE DI ESTRAZIONE E GESTIONE DOM/AJAX
    // =====================================================================
    protected async scrapeSingleMarket(task: Task): Promise<WorkerResult> {
        try {
            console.log(`[Scraper - ${this.name}] Fetching ${task.asin} su ${task.market}...`);
            const url = `https://www.${task.market}/dp/${task.asin}`;
            const html = await this.fetchHtmlWithRetry(url, task.market);
            
            const $ = cheerio.load(html);

            // Anti-Bot Fatale (CAPTCHA)
            if ($('title').text().includes('Robot Check') ||$('form[action="/errors/validateCaptcha"]').length > 0) {
                await notifier.sendAlert("CAPTCHA RILEVATO", `Blocco WAF su ${task.market} per ${task.asin}.`);
                throw new Error("CAPTCHA_DETECTED");
            }

            // Totalmente esaurito
            if ($('#outOfStock').length > 0) {
                return this.createEmptyResult(task);
            }

            // Unqualified BuyBox (Senza BuyBox principale ma ci sono offerte esterne)
            if ($('#unqualifiedBuyBox').length > 0 || $('.apex-core-price-identifier').length === 0) {
                console.log(`[Scraper - ${this.name}] Nessuna BuyBox per ${task.asin}. Lancio richiesta AJAX AOD...`);
                return await this.extractFromAodAjax(task);
            }

            return this.parseProductData($, task);

        } catch (error: any) {
            return { success: false, error: error.message, timestamp: new Date() };
        }
    }

    // CHIAMATA AJAX REALE ALL' ALL OFFERS DISPLAY (AOD)
    private async extractFromAodAjax(task: Task): Promise<WorkerResult> {
        const aodUrl = `https://www.${task.market}/gp/product/ajax/aodAjaxMain/ref=dp_aod_unknown_mbc?asin=${task.asin}&pc=dp`;
        
        // Spoofing Headers per emulare XMLHttpRequest
        const customHeaders = {
            'accept': 'text/html,*/*',
            'x-requested-with': 'XMLHttpRequest',
            'referer': `https://www.${task.market}/dp/${task.asin}`
        };

        const aodHtml = await this.fetchHtmlWithRetry(aodUrl, task.market, customHeaders);
        const $aod = cheerio.load(aodHtml);

        let bestPrice: number | null = null;
        let bestShipping: number | null = null;

        $aod('#aod-offer').each((_, element) => {
            const $offer =$aod(element);
            
            const conditionText = $offer.find('#aod-offer-heading').text().toLowerCase();
            const isNew = conditionText.includes('new') || conditionText.includes('nuovo') || conditionText.includes('neuf') || conditionText.includes('neu');
            
            if (!isNew) return true; // Skips to next iteration se è un usato

            const identifierDiv = $offer.find('.apex-core-price-identifier').first();
            if (identifierDiv.length > 0) {
                const rawPrice = identifierDiv.attr('data-csa-c-price-to-pay');
                const rawShipping = identifierDiv.attr('data-csa-c-shipping-charge');

                if (rawPrice && rawPrice !== "FREE") {
                    bestPrice = parseFloat(rawPrice);
                    bestShipping = (!rawShipping || rawShipping === "FREE") ? 0.0 : parseFloat(rawShipping);
                    return false; // Interrompe l'iterazione, trovato il prezzo più basso
                }
            }
        });

        if (bestPrice === null) return this.createEmptyResult(task);

        return {
            success: true, timestamp: new Date(),
            data: { asin: task.asin, market: task.market, price: bestPrice, shippingCost: bestShipping ?? 0.0, currency: "EUR" }
        };
    }

    private parseProductData($: cheerio.CheerioAPI, task: Task): WorkerResult {
        const identifierDiv = $('.apex-core-price-identifier').first();
        let price: number | null = null;
        let shippingCost: number | null = null;

        if (identifierDiv.length > 0) {
            const rawPrice = identifierDiv.attr('data-csa-c-price-to-pay');
            const rawShipping = identifierDiv.attr('data-csa-c-shipping-charge');

            if (rawPrice && rawPrice !== "FREE") price = parseFloat(rawPrice);
            if (rawShipping && rawShipping !== "FREE") shippingCost = parseFloat(rawShipping);
        }

        if (price === null) {
            const offscreenText = $('.apex-pricetopay-value .a-offscreen').first().text().trim() 
                || $('#corePrice_feature_div .a-price .a-offscreen').first().text().trim();
                
            if (offscreenText) {
                const cleaned = offscreenText.replace(/[^\d,.]/g, ''); 
                const withoutThousands = cleaned.replace(/\./g, '');
                price = parseFloat(withoutThousands.replace(',', '.'));
            }
        }

        if (shippingCost === null) {
            shippingCost = this.fallbackShippingExtraction($);
        }

        if (price === null || isNaN(price)) return this.createEmptyResult(task);

        return {
            success: true, timestamp: new Date(),
            data: { asin: task.asin, market: task.market, price, shippingCost: isNaN(shippingCost) ? 0 : shippingCost, currency: "EUR" }
        };
    }

    private fallbackShippingExtraction($: cheerio.CheerioAPI): number {
        const deliveryText = ($('#deliveryBlockMessage').text() + ' ' + $('#mir-layout-DELIVERY_BLOCK').text()).toLowerCase();
        
        const freeShippingKeywords = [
            'gratuita', 'gratis', 'senza costi aggiuntivi', 'inclusa',
            'gratuit', 'gratuite', 'sans frais', 'inclus', 'offerte', 'livraison gratuite',
            'kostenlose', 'kostenlos', 'kostenfreier', 'kostenfrei', 'ohne zusätzliche kosten'
        ];

        if (freeShippingKeywords.some(kw => deliveryText.includes(kw))) return 0.0;

        const shippingMatch = deliveryText.match(/(?:€|eur)?\s*(\d+[,.]\d+)\s*(?:€|eur)?/i);
        if (shippingMatch) return parseFloat(shippingMatch[1].replace(',', '.'));
        
        return 0.0;
    }

    // =====================================================================
    // RESILIENZA E MICRO-RETRY DI RETE
    // =====================================================================
    private async fetchHtmlWithRetry(url: string, market: AmazonMarket, extraHeaders: Record<string, string> = {}): Promise<string> {
        const localeMap: Record<AmazonMarket, string[]> = {
            'amazon.it': ['it-IT', 'en-US'], 'amazon.fr': ['fr-FR', 'en-US'], 'amazon.de': ['de-DE', 'en-US'],
        };
        
        let attempt = 0;
        const MAX_RETRIES = 3;

        while (attempt < MAX_RETRIES) {
            try {
                const response = await gotScraping({
                    url: url,
                    cookieJar: this.cookieJar,
                    headers: extraHeaders,
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome', minVersion: 110 }],
                        devices: ['desktop'],
                        locales: localeMap[market],
                        operatingSystems: ['windows']
                    }
                });
                return response.body;
            } catch (error: any) {
                attempt++;
                if (attempt >= MAX_RETRIES || error.response?.statusCode === 404) throw error;
                
                const backoff = (Math.random() * 2) + 3; // Retry rapido 3-5s
                console.warn(`[Rete - ${this.name}] 502/Timeout su ${market}. Retry ${attempt}/${MAX_RETRIES} tra ${backoff.toFixed(1)}s...`);
                await this.sleep(backoff);
            }
        }
        throw new Error("NETWORK_FAILURE");
    }

    private sleep(seconds: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }

    private createEmptyResult(task: Task): WorkerResult {
        return { success: true, timestamp: new Date(), data: { asin: task.asin, market: task.market, price: null, shippingCost: null, currency: "EUR" } };
    }

    public async execute(task: Task): Promise<WorkerResult> { 
        throw new Error("Il CustomScraperWorker deve essere avviato unicamente tramite executeDailyMission()"); 
    }
}