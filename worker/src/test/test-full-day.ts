import { PrismaClient } from "@prisma/client";
import { SmartDispatcher, ApiWorker } from "../worker";
import { MockScraperWorker } from "./MockScraperWorker";
import { MockApiAdapter } from "./MockApiAdapter";
import { WorkerLimits } from "../types";

const prisma = new PrismaClient();

async function runTest() {
    console.log("=== STARTING FULL DAY TEST ===");

    // Clear old products
    await prisma.product.deleteMany({});

    // Create some fake products
    for (let i = 0; i < 50; i++) {
        await prisma.product.create({
            data: {
                asin: `FULL_DAY_ASIN_${i}`,
                name: `Full Day Test Product ${i}`,
                image: "http://example.com/img.jpg",
                priorityCode: (i % 7) + 1,
                mustTomorrow: i % 10 === 0,
                lastUpdated: new Date(Date.now() - 1000 * 60 * 60 * 24 * (i % 5)), // 0 to 4 days ago
            }
        });
    }

    const dispatcher = new SmartDispatcher(prisma);

    const apiLimits: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorker = new ApiWorker("MockAPI", "FAKE_KEY", new MockApiAdapter(), apiLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    const scraperLimits: WorkerLimits = { dailyLimit: 100, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("MockScraper", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    
    (scraperWorker as any).handleLongPauses = async function() { return Promise.resolve(); };
    (scraperWorker as any).sleep = async function(seconds: number) { return Promise.resolve(); };


    const originalApiExecute = (apiWorker as any).execute.bind(apiWorker);
    (apiWorker as any).execute = async function(task: any) {

        console.log(`[API Mock] Executing task ${task.asin} on ${task.market}`);
        const apiAdapter = new MockApiAdapter();
        const rawResponse = { asin: task.asin, market: task.market, product_results: { extracted_price: 25.99 } };
        const data = apiAdapter.extractData(rawResponse);
        return { success: true, timestamp: new Date(), data };
    };

    dispatcher.registerWorker(apiWorker);
    dispatcher.registerWorker(scraperWorker);

    console.log("Running Dispatcher...");

    await dispatcher.run();

    console.log("Full Day test completed successfully!");

    await prisma.$disconnect();
}

console.log("Full Day test script generated. User requested not to run it directly.");
// runTest().catch(console.error);
