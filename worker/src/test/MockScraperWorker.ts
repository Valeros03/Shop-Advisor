import { CustomScraperWorker } from "../scraper/scraper";
import { Task, WorkerResult, AmazonMarket, WorkerLimits } from "../types";

export class MockScraperWorker extends CustomScraperWorker {
    constructor(
        name: string,
        limits: WorkerLimits,
        supportedMarkets: AmazonMarket[],
        initialUsage: { daily: number; monthly: number; lifetime: number }
    ) {
        super(name, limits, supportedMarkets, initialUsage);
    }

    protected async scrapeSingleMarket(task: Task): Promise<WorkerResult> {
        console.log(`[MockScraper - ${this.name}] Simulating fetch for ${task.asin} on ${task.market}...`);
        await new Promise(res => setTimeout(res, 50));
        if (Math.random() < 0.1) {
            return {
                success: false,
                error: "MOCK_NETWORK_FAILURE",
                timestamp: new Date()
            };
        }
        const price = Math.round((Math.random() * 50 + 20) * 100) / 100;
        const shippingCost = Math.random() > 0.7 ? 5.99 : 0;
        return {
            success: true,
            timestamp: new Date(),
            data: {
                asin: task.asin,
                market: task.market,
                price,
                shippingCost,
                currency: "EUR"
            }
        };
    }

    public async testExecute(task: Task): Promise<WorkerResult> {
        return this.scrapeSingleMarket(task);
    }
}
