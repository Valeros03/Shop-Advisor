import { CustomScraperWorker } from "../scraper/scraper";
import { Task, WorkerLimits, AmazonMarket } from "../types";
import * as fs from "fs";
import * as path from "path";

// Create a subclass to test the fallback regex functionality
class TestFallbackScraperWorker extends CustomScraperWorker {
    constructor(
        name: string,
        limits: WorkerLimits,
        supportedMarkets: AmazonMarket[],
        initialUsage = { daily: 0, monthly: 0, lifetime: 0 }
    ) {
        super(name, limits, supportedMarkets, initialUsage);
    }

    // Override fetchHtmlWithRetry to return predefined HTML missing the standard price tags but containing the regex matches
    protected async fetchHtmlWithRetry(url: string, market: AmazonMarket, extraHeaders: Record<string, string> = {}): Promise<string> {
        return `
            <html>
                <body>
                    <div id="some-random-div">
                        <span>Questo e un testo a caso</span>
                    </div>
                    <div class="test-price-tag">
                        EUR 35,99
                    </div>
                    <div class="test-shipping-tag">
                        Spedizione gratuita
                    </div>
                </body>
            </html>
        `;
    }

    public async testExecute(task: Task) {
        return this.scrapeSingleMarket(task);
    }
}

async function runTest() {
    console.log("=== STARTING FALLBACK REGEX TEST ===");

    const task: Task = { asin: "TEST_ASIN", market: "amazon.it", isMustTomorrow: false };
    const limits: WorkerLimits = { dailyLimit: 10, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };

    const scraperWorker = new TestFallbackScraperWorker("TestFallbackScraper", limits, ["amazon.it"]);

    const result = await scraperWorker.testExecute(task);

    console.log("Result:", result);

    const dir = path.join(process.cwd(), 'debug');
    const filePath = path.join(dir, `${task.asin}_${task.market}_fallback.xml`);

    if (fs.existsSync(filePath)) {
        console.log(`[Success] Fallback XML file was created at: ${filePath}`);
        const content = fs.readFileSync(filePath, "utf-8");
        console.log("=== XML Content ===");
        console.log(content);

        // Clean up
        fs.unlinkSync(filePath);
        console.log("[Cleaned up XML file]");
    } else {
        console.error(`[Failure] Fallback XML file was NOT created!`);
        process.exit(1);
    }

    console.log("Fallback Regex Test successful!");
}

runTest().catch(console.error);
