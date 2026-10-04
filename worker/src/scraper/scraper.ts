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

    private isPastMidnight(): boolean {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Rome',
            hour: 'numeric',
            hour12: false
        }).formatToParts(new Date());
        const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
        
        // Se siamo tra le 00:00 e le 06:59 del mattino, la giornata operativa è conclusa
        return hour >= 0 && hour < 7;
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
        console.log(`[Scraper - ${this.name}] Organizzazione di ${tasks.length} task in cluster coerenti...`);

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

        console.log(`[Scraper - ${this.name}] Generati ${this.timelineQueue.length} cluster esecutivi sincronizzati con il Dispatcher.`);
    }

    // =====================================================================
    // LIVELLO 3.C/D/E: ESECUZIONE DELLA TIMELINE (Pacing e Limiti Tassativi)
    // =====================================================================
    public async executeDailyMission(updater: ProductUpdater): Promise<void> {
        while (this.timelineQueue.length > 0) {
            // 1. Controllo limite mezzanotte prima di estrarre il task
            if (this.isPastMidnight()) {
                console.warn(`[Scraper - ${this.name}] Mezzanotte raggiunta! Stop a nuovi task.`);
                
                // Informa l'updater di tutti i task scartati per non lasciarlo in attesa
                for (const job of this.timelineQueue) {
                    updater.cancelPendingTask(job.task.asin, job.task.market, job.task.cycleIndex ?? 0);
                }
                this.timelineQueue = [];
                break;
            }

            const scheduledJob = this.timelineQueue.shift()!;
            
            // 2. Attesa dello slot temporale programmato
            const msUntilTarget = scheduledJob.targetTime - Date.now();
            if (msUntilTarget > 0) {
                await new Promise(resolve => setTimeout(resolve, msUntilTarget));
            }

            // 3. Secondo controllo dopo l'attesa (in caso l'attesa abbia superato mezzanotte)
            if (this.isPastMidnight()) {
                console.warn(`[Scraper - ${this.name}] Mezzanotte superata durante l'attesa per ${scheduledJob.task.asin}.`);
                updater.cancelPendingTask(scheduledJob.task.asin, scheduledJob.task.market, scheduledJob.task.cycleIndex ?? 0);
                
                for (const job of this.timelineQueue) {
                    updater.cancelPendingTask(job.task.asin, job.task.market, job.task.cycleIndex ?? 0);
                }
                this.timelineQueue = [];
                break;
            }

            // 4. Rate limiting organico
            await this.enforceRateLimit();

            // 5. Esecuzione task
            try {
                const result = await this.scraper.scrape(scheduledJob.task);
                await updater.submitResult(
                    scheduledJob.task.asin, 
                    scheduledJob.task.market, 
                    result, 
                    scheduledJob.task.cycleIndex ?? 0
                );
            } catch (error: any) {
                console.error(`[Scraper - ${this.name}] Fallimento task ${scheduledJob.task.asin} (${scheduledJob.task.market}):`, error.message);
                
                await updater.submitResult(
                    scheduledJob.task.asin, 
                    scheduledJob.task.market, 
                    { success: false, error: error.message, timestamp: new Date() }, 
                    scheduledJob.task.cycleIndex ?? 0
                );
            }
        }
        console.log(`[Scraper - ${this.name}] Chiusura ciclo giornaliero.`);
    }

   private getItalianTime(): { hour: number; now: Date } {
    const now = new Date();
    // Ottiene l'ora formattata sul fuso di Roma
    const italianHourStr = new Intl.DateTimeFormat('it-IT', {
        timeZone: 'Europe/Rome',
        hour: 'numeric',
        hour12: false
    }).format(now);
    
    return { hour: parseInt(italianHourStr, 10), now };
}

private async handleLongPauses(): Promise<void> {
    const { hour, now } = this.getItalianTime();
    
    // Finestra notturna: dalle 23:00 di sera fino alle 07:00 del mattino (orario italiano)
    if (hour >= 23 || hour < 7) {
        // Calcola i millisecondi esatti che mancano alle 07:00 del mattino
        const next7AM = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
        if (hour >= 23) {
            next7AM.setDate(next7AM.getDate() + 1);
        }
        next7AM.setHours(7, 0, 0, 0);

        const msUntilMorning = Math.max(10000, next7AM.getTime() - now.getTime());
        const hoursLeft = (msUntilMorning / (1000 * 60 * 60)).toFixed(1);

        console.log(`[Scraper - ${this.name}] Sospensione notturna attiva (${hour}:00). Pausa calcolata fino alle 07:00 (~${hoursLeft}h)...`);
        await this.sleep(msUntilMorning / 1000);
        console.log(`[Scraper - ${this.name}] Ore 07:00 raggiunte. Ripresa scansioni!`);
        return;
    }

    // Tassativa: 1 o 2 pause lunghe durante il giorno (30-60 min tra le 11:00 e le 21:00)
    if (this.longPausesDone < 2 && hour >= 11 && hour <= 21 && Math.random() < 0.05) {
        const pausaMinuti = Math.floor(Math.random() * 31) + 30;
        console.log(`[Scraper - ${this.name}] Avvio pausa lunga di ${pausaMinuti} min...`);
        this.longPausesDone++;
        await this.sleep(pausaMinuti * 60);
    }
}


    private extractIsSoldByAmazon($: cheerio.CheerioAPI): boolean {
        // 1. Cerca specificamente nel container delle informazioni del venditore (Merchant Info)
        const merchantContainer = $('#merchantInfoFeature_feature_div');
        if (merchantContainer.length > 0) {
            // Estrae il testo dell'effettivo messaggio o link del venditore
            const merchantText = merchantContainer
                .find('.offer-display-feature-text-message, #sellerProfileTriggerId, .a-size-small')
                .text()
                .trim()
                .toLowerCase();

            // Se il venditore contiene esplicitamente "amazon", è un prodotto 1P
            if (merchantText.includes('amazon')) {
                return true;
            }

            // Se nel blocco merchant c'è del testo diverso (es. "Patriot Memory France"), è un venditore terzo
            if (merchantText.length > 0) {
                return false;
            }
        }

        // 2. Fallback per layout Amazon alternativi o più vecchi
        const tabularMerchant = $('#tabular-buybox .tabular-buybox-text[tabular-attribute-name*="merchant"]');
        if (tabularMerchant.length > 0) {
            return tabularMerchant.text().toLowerCase().includes('amazon');
        }

        const merchantInfoLegacy = $('#merchant-info').text().toLowerCase();
        if (merchantInfoLegacy.length > 0) {
            // Controlla se è venduto da Amazon (es. "venduto e spedito da amazon", "vendu par amazon", "sold by amazon")
            const soldByAmazonRegex = /(?:venduto|vendu|sold|verkauft)\s+(?:da|par|by|von)\s+amazon/i;
            if (soldByAmazonRegex.test(merchantInfoLegacy)) {
                return true;
            }
            // Se dice solo spedito da Amazon ma venduto da altri
            return false;
        }

        return false;
    }

    public async performFallbackRegexSearch(mainHtml: string, aodHtml: string | null, task: Task) {
        console.log(`[Scraper - ${this.name}] Generazione file diagnostico unificato per ${task.asin} (${task.market})...`);

        const priceRegexes = [
            /(?:EUR|€)\s*\d+([.,]\d{2})?/i,
            /\d+([.,]\d{2})?\s*(?:EUR|€)/i,
            /\b\d{2,4}[.,]\d{2}\s*€/i
        ];

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

        const extractMatches = (html: string): TagMatch[] => {
            const $ = cheerio.load(html);
            const matches: TagMatch[] = [];

            $('span, div, b, strong, p, td, a').not('script, style, noscript, svg').each((_, element) => {
                const $el =$(element);
                if ($el.children().length > 2) return;

                const text = $el.text().replace(/\s+/g, ' ').trim();
                if (!text || text.length > 80) return;

                for (const regex of priceRegexes) {
                    if (regex.test(text)) {
                        matches.push({
                            type: "PRICE",
                            tag: element.name,
                            id: $el.attr('id') || undefined,
                            className: $el.attr('class') || undefined,
                            text
                        });
                        break;
                    }
                }

                for (const regex of shippingRegexes) {
                    if (regex.test(text)) {
                        matches.push({
                            type: "SHIPPING",
                            tag: element.name,
                            id: $el.attr('id') || undefined,
                            className: $el.attr('class') || undefined,
                            text
                        });
                        break;
                    }
                }
            });

            return matches.filter((match, index, self) =>
                index === self.findIndex((m) => m.text === match.text && m.className === match.className)
            );
        };

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

        const renderSectionXml = (sectionName: string, matches: TagMatch[]) => {
            const prices = matches.filter(m => m.type === "PRICE");
            const shipping = matches.filter(m => m.type === "SHIPPING");

            let out = `  <${sectionName} totalMatches="${matches.length}">\n`;
            out += `    <Prices count="${prices.length}">\n`;
            for (const m of prices) {
                out += `      <Match tag="${escapeXml(m.tag)}" id="${escapeXml(m.id || '')}" class="${escapeXml(m.className || '')}">\n`;
                out += `        <Text>${escapeXml(m.text)}</Text>\n`;
                out += `      </Match>\n`;
            }
            out += `    </Prices>\n`;

            out += `    <Shipping count="${shipping.length}">\n`;
            for (const m of shipping) {
                out += `      <Match tag="${escapeXml(m.tag)}" id="${escapeXml(m.id || '')}" class="${escapeXml(m.className || '')}">\n`;
                out += `        <Text>${escapeXml(m.text)}</Text>\n`;
                out += `      </Match>\n`;
            }
            out += `    </Shipping>\n`;
            out += `  </${sectionName}>\n`;
            return out;
        };

        const mainMatches = extractMatches(mainHtml);
        const aodMatches = aodHtml ? extractMatches(aodHtml) : [];

        let xmlOutput = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xmlOutput += `<UnifiedFallbackInspection asin="${escapeXml(task.asin)}" market="${escapeXml(task.market)}" timestamp="${new Date().toISOString()}">\n`;
        xmlOutput += renderSectionXml("MainPageInspection", mainMatches);
        if (aodHtml) {
            xmlOutput += renderSectionXml("AodAjaxInspection", aodMatches);
        } else {
            xmlOutput += `  <AodAjaxInspection status="NOT_CALLED" />\n`;
        }
        xmlOutput += `</UnifiedFallbackInspection>\n`;

        try {
            const dir = path.join(process.cwd(), 'debug');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, `${task.asin}_${task.market}_fallback.xml`);
            fs.writeFileSync(filePath, xmlOutput, 'utf-8');
            console.log(`[Scraper - ${this.name}] File diagnostico unificato salvato: ${filePath}`);
        } catch (err) {
            console.error(`[Scraper - ${this.name}] Errore salvataggio file XML:`, err);
        }

        try {
            const dir = path.join(process.cwd(), 'debug');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, `${task.asin}_${task.market}_fallback.xml`);
            fs.writeFileSync(filePath, xmlOutput, 'utf-8');
            console.log(`[Scraper - ${this.name}] File diagnostico unificato salvato: ${filePath}`);

            // --- INVIO NOTIFICA CON DIAGNOSTICA XML ---
            const subject = `SCRAPING ROTTO: ${task.asin} (${task.market})`;
            const message = `Lo scraper non è riuscito a identificare il prezzo né dalla pagina madre né da AOD AJAX.\n` +
                            `Mercato: ${task.market}\n` +
                            `ASIN: ${task.asin}\n` +
                            `File di debug generato: ${filePath}`;

            // Se il tuo NotificationService ha un metodo per inviare allegati (es. sendAlertWithAttachment):
            if (typeof (notifier as any).sendAlertWithAttachment === "function") {
                await (notifier as any).sendAlertWithAttachment(subject, message, filePath);
            } else {
                // Fallback standard con sendAlert già presente nel tuo NotificationService
                await notifier.sendAlert(subject, `${message}\n\nAnteprima XML:\n${xmlOutput.slice(0, 1500)}...`);
            }

        } catch (err) {
            console.error(`[Scraper - ${this.name}] Errore salvataggio file XML o invio notifica:`, err);
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

            if ($('title').text().includes('Robot Check') || $('form[action*="validateCaptcha"]').length > 0) {
                const wafAlertMsg = `BLOCCO WAF AMAZON RILEVATO!\n\n` +
                    `- Mercato: ${task.market}\n` +
                    `- ASIN: ${task.asin}\n` +
                    `- IP Macchina/Container intercettato da Amazon.\n` +
                    `- Azione consigliata: Verificare la rotazione IP o allungare le pause minime per evitare il ban persistente dell'IP di rete.`;

                console.error(`[Scraper - ${this.name}]  ${wafAlertMsg}`);
                
                // Invia email di priorità massima
                await notifier.sendAlert(`EMERGENZA ANTI-BOT: Blocco su ${task.market}`, wafAlertMsg);
                throw new Error("CAPTCHA_DETECTED");
            }

            if ($('#outOfStock').length > 0) {
                return this.createEmptyResult(task);
            }

            // 1. Prova di estrazione standard dalla pagina principale
            let mainPageResult = this.parseProductData($, task);
            let aodRawHtml: string | null = null;

            // 2. Se non ha BuyBox o il prezzo manca, prova l'All Offers Display (AOD)
            const hasNoBuyBox = $('#unqualifiedBuyBox').length > 0 || $('.apex-core-price-identifier').length === 0;
            const priceMissing = mainPageResult.data?.price === null || mainPageResult.data?.price === undefined;

            if (hasNoBuyBox || priceMissing) {
                console.log(`[Scraper - ${this.name}] BuyBox assente o incompleta per ${task.asin}. Lancio richiesta AJAX AOD...`);
                const { result: aodResult, rawHtml } = await this.extractFromAodAjax(task);
                aodRawHtml = rawHtml;

                if (aodResult.data?.price !== null && aodResult.data?.price !== undefined) {
                    return aodResult;
                }
            } else {
                return mainPageResult;
            }

            // 3. Fallback unificato: eseguito SOLO se entrambe le strade hanno fallito
            console.warn(`[Scraper - ${this.name}] Estrazione fallita sia su pagina principale che su AOD per ${task.asin} (${task.market}).`);
            await this.performFallbackRegexSearch(html, aodRawHtml, task);

            return this.createEmptyResult(task);

        } catch (error: any) {
            return { success: false, error: error.message, timestamp: new Date() };
        }
    }

    // CHIAMATA AJAX REALE ALL' ALL OFFERS DISPLAY (AOD)
    private async extractFromAodAjax(task: Task): Promise<{ result: WorkerResult; rawHtml: string | null }> {
        const aodUrl = `https://www.${task.market}/gp/product/ajax/aodAjaxMain?asin=${task.asin}&m=&qid=${Math.floor(Date.now() / 1000)}&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=8-1&pc=dp&experienceId=aodAjaxMain&pinnedOfferId=&filters=%7B%22all%22%3Atrue%2C%22new%22%3Atrue%7D`;

        const customHeaders = {
            'accept': 'text/html,*/*',
            'accept-language': 'it-IT,it;q=0.9,fr-FR,fr;q=0.8,de-DE,de;q=0.7,en-US;q=0.6',
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
            let bestOfferIsSoldByAmazon: boolean = false; // 1. Variabile per salvare se l'offerta migliore è di Amazon

            $aod('#aod-offer, #aod-pinned-offer, #all-offers-display-offer').each((_, element) => {
                const $offer = $aod(element);

                const conditionRaw = $offer.find('#aod-offer-heading, .aod-offer-heading').text().toLowerCase().trim();
                const isNew = conditionRaw.includes('new') || conditionRaw.includes('nuovo') || conditionRaw.includes('neuf') || conditionRaw.includes('neu');
                if (conditionRaw && !isNew) return true;

                // Estrazione Prezzo
                const identifierDiv = $offer.find('.apex-core-price-identifier').first();
                if (identifierDiv.length > 0) {
                    const rawPrice = identifierDiv.attr('data-csa-c-price-to-pay');
                    if (rawPrice && rawPrice !== "FREE") {
                        const parsedPrice = parseFloat(rawPrice);
                        if (!isNaN(parsedPrice) && (bestPrice === null || parsedPrice < bestPrice)) {
                            bestPrice = parsedPrice;
                        }
                    }
                }

                if (bestPrice === null) {
                    const priceText = $offer.find('.apex-pricetopay-accessibility-label, .apex-pricetopay-value .a-offscreen, .a-price .a-offscreen').first().text().trim();
                    if (priceText) {
                        const clean = priceText.replace(/[^\d,.]/g, '').replace(',', '.');
                        const p = parseFloat(clean);
                        if (!isNaN(p)) bestPrice = p;
                    }
                }

                // 2. QUI: Se abbiamo trovato un prezzo per questa offerta, ne leggiamo il venditore
                if (bestPrice !== null) {
                    const sellerText = $offer.find('#aod-offer-soldBy, [id*="soldBy"], .aod-offer-soldBy-text, #aod-offer-shipsFrom').text().toLowerCase();
                    bestOfferIsSoldByAmazon = sellerText.includes('amazon');
                }

                // Estrazione Spedizione
                if (bestPrice !== null && bestShipping === null) {
                    const rawShipping = identifierDiv.attr('data-csa-c-shipping-charge');
                    const deliveryAttr = $offer.find('[data-csa-c-delivery-price]').first().attr('data-csa-c-delivery-price');

                    if (rawShipping === "FREE" || (deliveryAttr && deliveryAttr.toUpperCase().includes('FREE'))) {
                        bestShipping = 0.0;
                    } else if (rawShipping) {
                        const parsedShip = parseFloat(rawShipping);
                        bestShipping = isNaN(parsedShip) ? 0.0 : parsedShip;
                    } else if (deliveryAttr) {
                        const cleanShip = deliveryAttr.replace(/[^\d,.]/g, '').replace(',', '.');
                        const s = parseFloat(cleanShip);
                        bestShipping = isNaN(s) ? 0.0 : s;
                    }

                    if (bestShipping === null) {
                        const shipBlockText = $offer.find('#aod-offer-shipping, .aod-ship-charge, #delivery-message').text().toLowerCase();
                        if (shipBlockText.includes('gratuita') || shipBlockText.includes('gratuit') || shipBlockText.includes('kostenlose') || shipBlockText.includes('free')) {
                            bestShipping = 0.0;
                        } else {
                            const shipMatch = shipBlockText.match(/(?:€|eur)?\s*(\d+[.,]\d{2})/i);
                            if (shipMatch) bestShipping = parseFloat(shipMatch[1].replace(',', '.'));
                        }
                    }
                }

                if (bestPrice !== null) return false;
            });

            if (bestPrice === null) {
                return { result: this.createEmptyResult(task), rawHtml: aodHtml };
            }

            // 3. QUI: Inseriamo isSoldByAmazon nell'oggetto finale restituito
            return {
                result: {
                    success: true,
                    timestamp: new Date(),
                    data: {
                        asin: task.asin,
                        market: task.market,
                        price: bestPrice,
                        shippingCost: bestShipping ?? 0.0,
                        currency: "EUR",
                        isSoldByAmazon: bestOfferIsSoldByAmazon
                    }
                },
                rawHtml: aodHtml
            };
        } catch (err: any) {
            console.error(`[Scraper - ${this.name}] Errore chiamata AOD AJAX:`, err.message);
            return { result: this.createEmptyResult(task), rawHtml: null };
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