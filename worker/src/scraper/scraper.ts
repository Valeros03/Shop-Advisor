import { BaseWorker } from "../worker";
import { Task, WorkerResult, WorkerLimits, AmazonMarket } from "../types";
import * as cheerio from "cheerio";
import { gotScraping } from "got-scraping";
import * as fs from "fs";
import * as path from "path";
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
    private virtualDailyUsage: number = 0;
    
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
        this.virtualDailyUsage = this.currentDailyUsage; // <-- AGGIUNTO: reset al valore iniziale
    }

    public consumeVirtualCurrency(isFirstTaskForAsin: boolean): boolean {
        // Se è impostato un tetto numerico giornaliero e lo abbiamo raggiunto, rifiuta il task
        if (this.limits.dailyLimit !== -1 && this.virtualDailyUsage >= this.limits.dailyLimit) {
            return false;
        }

        const MACRO_PAUSE_AVG = 82.5;
        const MICRO_PAUSE_AVG = 8.25;
        const NETWORK_FETCH_AVG = 7.0;
        
        let costSeconds = 0;

        if (isFirstTaskForAsin) {
            costSeconds = MACRO_PAUSE_AVG + NETWORK_FETCH_AVG;
        } else {
            costSeconds = MICRO_PAUSE_AVG + NETWORK_FETCH_AVG;
        }

        // Verifica la disponibilità sia temporale (secondi) sia di gettoni
        if (this.virtualSeconds >= costSeconds) {
            this.virtualSeconds -= costSeconds;
            this.virtualDailyUsage++; // <-- AGGIUNTO: scala il gettone virtuale
            return true;
        }
        return false;
    }

    // =====================================================================
    // LIVELLO 3.A: DELEGAZIONE E TIME-BUCKETING
    // =====================================================================
    public delegateAndOrganizeTasks(tasks: Task[]): void {
        console.log(`[Scraper - ${this.name}] 🗓️ Organizzazione di ${tasks.length} task in cluster coerenti...`);

        // 1. Raggruppa i task per ciclo dello stesso ASIN (es. ASIN_0_cycle_0, ASIN_0_cycle_1)
        // In questo modo i 3 mercati dello stesso ciclo rimangono uniti nello STESSO cluster
        const clusterMap = new Map<string, Task[]>();

        for (const task of tasks) {
            const key = `${task.asin}_cycle_${task.cycleIndex ?? 0}`;
            if (!clusterMap.has(key)) {
                clusterMap.set(key, []);
            }
            clusterMap.get(key)!.push(task);
        }

        const now = Date.now();
        const midnight = new Date();
        midnight.setHours(23, 59, 59, 999);
        const endOfDay = midnight.getTime();

        this.timelineQueue = [];

        // 2. Crea i cluster basandosi sui targetSlotTime forniti dal Dispatcher
        for (const [_, clusterTasks] of clusterMap.entries()) {
            // Se il task non ha targetSlotTime (es. nei vecchi test), usa now come fallback
            const baseTime = clusterTasks[0].targetSlotTime ?? now;
            
            // Jitter circoscritto (±45s) per naturalezza anti-bot senza alterare l'ondatata oraria
            const jitter = (Math.random() * 90000) - 45000;
            const targetTime = Math.min(Math.max(baseTime + jitter, now), endOfDay - 2000);

            this.timelineQueue.push({
                targetTime,
                cluster: {
                    asin: clusterTasks[0].asin,
                    tasks: clusterTasks,
                    isMustTomorrow: clusterTasks.some(t => t.isMustTomorrow)
                }
            });
        }

        // 3. Ordina cronologicamente per orario di esecuzione
        this.timelineQueue.sort((a, b) => a.targetTime - b.targetTime);

        console.log(`[Scraper - ${this.name}] ✅ Generati ${this.timelineQueue.length} cluster esecutivi sincronizzati con il Dispatcher.`);
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

    public performFallbackRegexSearch(html: string, task: Task) {
        console.log(`[Scraper - ${this.name}] 🔍 Avvio Fallback Regex su ${task.asin} (${task.market})...`);
        const $ = cheerio.load(html);

        // Regex per PREZZI: supporta formati europei (es. 699,00€, EUR 699.00, € 771,90)
        const priceRegexes = [
            /(?:EUR|€)\s*\d+([.,]\d{2})?/i,
            /\d+([.,]\d{2})?\s*(?:EUR|€)/i,
            /\b\d{2,4}[.,]\d{2}\s*€/i
        ];

        // Regex per SPEDIZIONE: include tedesco (Lieferung/Versand), italiano, francese e inglese
        const shippingRegexes = [
            /spedizione\s+gratuita|consegna\s+gratuita|senza\s+costi\s+aggiuntivi/i,
            /livraison\s+gratuite|envoi\s+gratuit/i,
            /kostenlose\s+lieferung|kostenloser\s+versand|gratis\s+versand/i,
            /free\s+delivery|free\s+shipping/i,
            /(?:lieferung|versand|spedizione|consegna|delivery|shipping)\s*(?:für|for|de)?\s*(?:EUR|€)?\s*\d+[.,]\d{2}/i,
            /\d+[.,]\d{2}\s*(?:EUR|€)?\s*(?:versand|delivery|shipping|di\s+spedizione)/i
        ];

        interface TagMatch {
            type: "PRICE" | "SHIPPING";
            tag: string;
            id?: string;
            className?: string;
            text: string;
        }

        const matches: TagMatch[] = [];

        // Scansiona i tag informativi foglia o semi-foglia (span, div, b, strong, p, td, a)
        $('span, div, b, strong, p, td, a').not('script, style, noscript, svg').each((_, element) => {
            const $el =$(element);
            
            // Se l'elemento ha più di 2 figli tag, è un contenitore strutturale: saltalo
            if ($el.children().length > 2) return;

            // Prendi il testo normalizzato (sostituisce whitespace multipli con singolo spazio)
            const text = $el.text().replace(/\s+/g, ' ').trim();
            if (!text || text.length > 80) return; // Salta testi troppo lunghi

            // Controllo PREZZO
            for (const regex of priceRegexes) {
                if (regex.test(text)) {
                    matches.push({
                        type: "PRICE",
                        tag: element.name,
                        id: $el.attr('id') || undefined,
                        className: $el.attr('class') || undefined,
                        text
                    });
                    console.log(`[Fallback Regex][PRICE] <${element.name} class="${$el.attr('class') || ''}"> -> ${text}`);
                    break;
                }
            }

            // Controllo SPEDIZIONE
            for (const regex of shippingRegexes) {
                if (regex.test(text)) {
                    matches.push({
                        type: "SHIPPING",
                        tag: element.name,
                        id: $el.attr('id') || undefined,
                        className: $el.attr('class') || undefined,
                        text
                    });
                    console.log(`[Fallback Regex][SHIPPING] <${element.name} class="${$el.attr('class') || ''}"> -> ${text}`);
                    break;
                }
            }
        });

        // Rimozione duplicati (stesso testo e stessa classe)
        const uniqueMatches = matches.filter((match, index, self) =>
            index === self.findIndex((m) => m.text === match.text && m.className === match.className)
        );

        if (uniqueMatches.length > 0) {
            const escapeXml = (unsafe: string) => unsafe.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case '\'': return '&apos;';
                    case '"': return '&quot;';
                    default: return c;
                }
            });

            let xmlOutput = `<?xml version="1.0" encoding="UTF-8"?>\n`;
            xmlOutput += `<FallbackInspection asin="${escapeXml(task.asin)}" market="${escapeXml(task.market)}" timestamp="${new Date().toISOString()}">\n`;
            
            xmlOutput += `  <Prices count="${uniqueMatches.filter(m => m.type === 'PRICE').length}">\n`;
            for (const m of uniqueMatches.filter(m => m.type === 'PRICE')) {
                xmlOutput += `    <Match tag="${escapeXml(m.tag)}" id="${escapeXml(m.id || '')}" class="${escapeXml(m.className || '')}">\n`;
                xmlOutput += `      <Text>${escapeXml(m.text)}</Text>\n`;
                xmlOutput += `    </Match>\n`;
            }
            xmlOutput += `  </Prices>\n`;

            xmlOutput += `  <Shipping count="${uniqueMatches.filter(m => m.type === 'SHIPPING').length}">\n`;
            for (const m of uniqueMatches.filter(m => m.type === 'SHIPPING')) {
                xmlOutput += `    <Match tag="${escapeXml(m.tag)}" id="${escapeXml(m.id || '')}" class="${escapeXml(m.className || '')}">\n`;
                xmlOutput += `      <Text>${escapeXml(m.text)}</Text>\n`;
                xmlOutput += `    </Match>\n`;
            }
            xmlOutput += `  </Shipping>\n`;

            xmlOutput += `</FallbackInspection>\n`;

            try {
                const dir = path.join(process.cwd(), 'debug');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const filePath = path.join(dir, `${task.asin}_${task.market}_fallback.xml`);
                fs.writeFileSync(filePath, xmlOutput, 'utf-8');
                console.log(`[Scraper - ${this.name}] 📄 File diagnostico XML creato: ${filePath}`);
            } catch (err) {
                console.error(`[Scraper - ${this.name}] Errore salvataggio file XML:`, err);
            }
        } else {
            console.log(`[Scraper - ${this.name}] Nessun match rilevato per le regex di fallback.`);
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
                const aodResult = await this.extractFromAodAjax(task);
                if (aodResult.data?.price === null || aodResult.data?.price === undefined) {
                    this.performFallbackRegexSearch(html, task);
                }
                return aodResult;
            }

            const parsedResult = this.parseProductData($, task);
            if (parsedResult.data?.price === null || parsedResult.data?.price === undefined || parsedResult.data?.shippingCost === null) {
                this.performFallbackRegexSearch(html, task);
            }   
            return parsedResult;

        } catch (error: any) {
            return { success: false, error: error.message, timestamp: new Date() };
        }
    }

    // CHIAMATA AJAX REALE ALL' ALL OFFERS DISPLAY (AOD)
    private async extractFromAodAjax(task: Task): Promise<WorkerResult> {
        // Parametri query precisi per attivare l'endpoint AOD completo
        const aodUrl = `https://www.${task.market}/gp/product/ajax/aodAjaxMain?asin=${task.asin}&m=&qid=${Math.floor(Date.now() / 1000)}&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=8-1&pc=dp`;

        const customHeaders = {
            'accept': 'text/html,*/*',
            'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
            'x-requested-with': 'XMLHttpRequest',
            'referer': `https://www.${task.market}/dp/${task.asin}`,
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
        };

        try {
            const aodHtml = await this.fetchHtmlWithRetry(aodUrl, task.market, customHeaders);
            const $aod = cheerio.load(aodHtml);

            let bestPrice: number | null = null;
            let bestShipping: number | null = null;

            // Scansiona tutti i blocchi offerta (incluso il pinned se presente)
            $aod('#aod-offer, #aod-pinned-offer').each((_, element) => {
                const $offer =$aod(element);

                // Controllo condizione: accetta "New", "Nuovo", "Neuf", "Neu"
                const conditionRaw = $offer.find('#aod-offer-heading').text().toLowerCase().trim();
                const isNew = conditionRaw.includes('new') || 
                              conditionRaw.includes('nuovo') || 
                              conditionRaw.includes('neuf') || 
                              conditionRaw.includes('neu');

                // Se c'è un'indicazione esplicita e NON è nuovo (es. usato/ricondizionato), salta
                if (conditionRaw && !isNew) return true;

                // 1. Estrazione da attributo data-csa-c-price-to-pay
                const identifierDiv = $offer.find('.apex-core-price-identifier').first();
                if (identifierDiv.length > 0) {
                    const rawPrice = identifierDiv.attr('data-csa-c-price-to-pay');
                    const rawShipping = identifierDiv.attr('data-csa-c-shipping-charge');

                    if (rawPrice && rawPrice !== "FREE") {
                        const parsedPrice = parseFloat(rawPrice);
                        if (!isNaN(parsedPrice) && (bestPrice === null || parsedPrice < bestPrice)) {
                            bestPrice = parsedPrice;

                            if (rawShipping === "FREE" || !rawShipping) {
                                bestShipping = 0.0;
                            } else {
                                const parsedShip = parseFloat(rawShipping);
                                bestShipping = isNaN(parsedShip) ? 0.0 : parsedShip;
                            }
                        }
                    }
                }

                // 2. Fallback interno all'offerta: se data-csa non c'era, leggi il testo visibile
                if (bestPrice === null) {
                    const priceText = $offer.find('.apex-pricetopay-accessibility-label, .apex-pricetopay-value .a-offscreen').first().text().trim();
                    if (priceText) {
                        const clean = priceText.replace(/[^\d,.]/g, '').replace(',', '.');
                        const p = parseFloat(clean);
                        if (!isNaN(p)) bestPrice = p;
                    }
                }

                // 3. Fallback spedizione da delivery-message
                if (bestShipping === null) {
                    const deliveryEl = $offer.find('[data-csa-c-delivery-price]').first();
                    const deliveryAttr = deliveryEl.attr('data-csa-c-delivery-price');
                    if (deliveryAttr) {
                        if (deliveryAttr.toUpperCase().includes('FREE')) {
                            bestShipping = 0.0;
                        } else {
                            const shipClean = deliveryAttr.replace(/[^\d,.]/g, '').replace(',', '.');
                            const s = parseFloat(shipClean);
                            bestShipping = isNaN(s) ? 0.0 : s;
                        }
                    }
                }

                // Appena troviamo la prima offerta NUOVA (sono già ordinate per prezzo crescente da Amazon), fermati
                if (bestPrice !== null) return false;
            });

            if (bestPrice === null) {
                return this.createEmptyResult(task);
            }

            return {
                success: true,
                timestamp: new Date(),
                data: {
                    asin: task.asin,
                    market: task.market,
                    price: bestPrice,
                    shippingCost: bestShipping ?? 0.0,
                    currency: "EUR"
                }
            };
        } catch (err: any) {
            console.error(`[Scraper - ${this.name}] Errore chiamata AOD AJAX:`, err.message);
            return this.createEmptyResult(task);
        }
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
        
            console.log("DEBUG RAW PRICE:", rawPrice);
        }

        
        
        if (price === null) {
            const offscreenText = $('.apex-pricetopay-value .a-offscreen').first().text().trim() 
                || $('#corePrice_feature_div .a-price .a-offscreen').first().text().trim();
                
            if (offscreenText) {
                // Rimuove la valuta e spazi, lasciando solo cifre, punti e virgole
                let clean = offscreenText.replace(/[^\d,.]/g, '').trim();

                if (clean.includes(',') && clean.includes('.')) {
                    // Caso con entrambi i separatori: es. "1.249,99" (EU) o "1,249.99" (US)
                    const lastDot = clean.lastIndexOf('.');
                    const lastComma = clean.lastIndexOf(',');
                    
                    if (lastComma > lastDot) {
                        // Formato europeo: 1.249,99 -> rimuovi i punti, sostituisci virgola con punto
                        clean = clean.replace(/\./g, '').replace(',', '.');
                    } else {
                        // Formato anglosassone: 1,249.99 -> rimuovi le virgole
                        clean = clean.replace(/,/g, '');
                    }
                } else if (clean.includes(',')) {
                    // Solo virgola decimale: es. "744,80" -> "744.80"
                    clean = clean.replace(',', '.');
                }
                // Se contiene solo il punto (es. "744.80"), clean rimane invariato

                price = parseFloat(clean);
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
    protected async fetchHtmlWithRetry(url: string, market: AmazonMarket, extraHeaders: Record<string, string> = {}): Promise<string> {
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