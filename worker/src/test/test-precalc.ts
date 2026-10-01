import { PrismaClient } from "@prisma/client";
import { SmartDispatcher, ApiWorker } from "../worker";
import { MockScraperWorker } from "./MockScraperWorker";
import { MockApiAdapter } from "./MockApiAdapter";
import { WorkerLimits } from "../types";

const prisma = new PrismaClient();

async function runTest() {
    console.log("=== STARTING PRECALC TEST WITH 100 FAKE ASINS ===");

    // Clear old products
    await prisma.product.deleteMany({});

    // Create 100 fake products
    for (let i = 0; i < 100; i++) {
        await prisma.product.create({
            data: {
                asin: `ASIN_${i}`,
                name: `Test Product ${i}`,
                image: "http://example.com/img.jpg",
                priorityCode: (i % 7) + 1,
                mustTomorrow: i % 5 === 0,
                lastUpdated: new Date(Date.now() - 1000 * 60 * 60 * 24 * (i % 5)), // 0 to 4 days ago
            }
        });
    }

    const dispatcher = new SmartDispatcher(prisma);

    // API 1: Only for amazon.it
    const apiLimitsIT: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerIT = new ApiWorker("MockAPI_IT", "FAKE_KEY", new MockApiAdapter(), apiLimitsIT, ["amazon.it"], { daily: 0, monthly: 0, lifetime: 0 });

    // API 2: For all markets
    const apiLimitsAll: WorkerLimits = { dailyLimit: 100, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerAll = new ApiWorker("MockAPI_All", "FAKE_KEY", new MockApiAdapter(), apiLimitsAll, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    // Scraper Worker
    const scraperLimits: WorkerLimits = { dailyLimit: 200, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("MockScraper", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    dispatcher.registerWorker(apiWorkerIT);
    dispatcher.registerWorker(apiWorkerAll);
    dispatcher.registerWorker(scraperWorker);

    const rawProducts = await prisma.product.findMany({
        select: {
            id: true, asin: true, priorityCode: true, mustTomorrow: true, lastUpdated: true,
            _count: { select: { alerts: { where: { isActive: true } } } }
        }
    });

    const dispatcherProducts = rawProducts.map(p => ({
        id: p.id, asin: p.asin, priorityCode: p.priorityCode, mustTomorrow: p.mustTomorrow,
        lastUpdated: p.lastUpdated, isUserTracked: p._count.alerts > 0
    }));

    // Call private method `simulateGlobalThroughput`
    const maxCompleteProducts = (dispatcher as any).simulateGlobalThroughput(dispatcherProducts);
    console.log(`Max Complete Products Calculated: ${maxCompleteProducts}`);

    const tasks = await dispatcher.planDailyTasks(dispatcherProducts, maxCompleteProducts * 3);
    console.log(`Total Tasks Planned: ${tasks.length}`);

    if (tasks.length > 0) {
        console.log("Precalc test successful!");
    } else {
        console.error("Precalc test failed, no tasks generated.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);
