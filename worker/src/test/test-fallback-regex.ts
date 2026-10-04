import { CustomScraperWorker } from "../scraper/scraper";
import { Task, WorkerLimits, AmazonMarket } from "../types";
import * as fs from "fs";
import * as path from "path";

class DiagnosticScraperWorker extends CustomScraperWorker {
    // Esegue lo scraping reale e forza SEMPRE l'analisi regex e la creazione dell'XML
    public async inspectPageWithRegex(task: Task) {
        console.log(`[Test] Scaricamento HTML per ${task.asin} su ${task.market}...`);
        
        // 1. Estrazione Standard (che fa la chiamata principale e poi quella AOD)
        const standardResult = await this.scrapeSingleMarket(task);
        console.log("\n--- Risultato Estrazione Standard ---");
        console.log(standardResult);

        // 2. Scarica direttamente l'endpoint AOD che contiene le vere offerte
        const aodUrl = `https://www.${task.market}/gp/product/ajax/aodAjaxMain?asin=${task.asin}&m=&qid=${Math.floor(Date.now() / 1000)}&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=8-1&pc=dp`;
        const customHeaders = {
            'accept': 'text/html,*/*',
            'x-requested-with': 'XMLHttpRequest',
            'referer': `https://www.${task.market}/dp/${task.asin}`
        };
        
        console.log("\n--- Scaricamento HTML del pannello offerte AOD ---");
        const aodHtml = await this.fetchHtmlWithRetry(aodUrl, task.market, customHeaders);

        // 3. Esegui la scansione regex sull'HTML di AOD
        console.log("\n--- Scansione Fallback Regex sul pannello AOD ---");
        this.performFallbackRegexSearch(aodHtml, task);
    }
}

async function runTest() {
    console.log("=== STARTING DIAGNOSTIC FALLBACK REGEX TEST ===");

    // Inserisci l'ASIN reale che vuoi esaminare
    const task: Task = { 
        asin: "B0DSG8LXX9", 
        market: "amazon.de", 
        isMustTomorrow: false 
    };

    const limits: WorkerLimits = { dailyLimit: 10, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new DiagnosticScraperWorker("DiagnosticScraper", limits, ["amazon.it"]);

    await scraperWorker.inspectPageWithRegex(task);

    const dir = path.join(process.cwd(), 'debug');
    const filePath = path.join(dir, `${task.asin}_${task.market}_fallback.xml`);

    if (fs.existsSync(filePath)) {
        console.log(`\n TEST COMPLETATO: File XML generato correttamente in:\n${filePath}`);
    } else {
        console.error(`\n ERRORE: Nessun file XML generato (nessun tag intercettato dalle regex).`);
    }
}

runTest().catch(console.error);