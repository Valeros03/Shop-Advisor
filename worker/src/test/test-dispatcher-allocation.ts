import { PrismaClient } from "@prisma/client";
import { SmartDispatcher, ApiWorker } from "../worker";
import { MockScraperWorker } from "./MockScraperWorker";
import { MockApiAdapter } from "./MockApiAdapter";
import { WorkerLimits, Task } from "../types";
import { BaseWorker } from "../worker";

const prisma = new PrismaClient();

async function runTest() {
    console.log("=== STARTING DISPATCHER ALLOCATION TEST ===");

    // Clear old products
    await prisma.product.deleteMany({});

    // Create exactly 10 fake products.
    // They are priority 1 (4 updates/day) and multi-market (3 markets: IT, FR, DE).
    // Total requested tasks = 10 * 4 * 3 = 120 tasks.
    for (let i = 0; i < 10; i++) {
        await prisma.product.create({
            data: {
                asin: `ASIN_ALLOC_${i}`,
                name: `Alloc Product ${i}`,
                image: "http://example.com/img.jpg",
                priorityCode: 1,
                mustTomorrow: false,
                lastUpdated: new Date(Date.now() - 1000 * 60 * 60 * 24), // yesterday
            }
        });
    }

    const dispatcher = new SmartDispatcher(prisma);

    // API 1: limit 5, cost 1, amazon.it only
    const apiLimitsIT: WorkerLimits = { dailyLimit: 5, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerIT = new ApiWorker("API_IT", "FAKE", new MockApiAdapter(), apiLimitsIT, ["amazon.it"], { daily: 0, monthly: 0, lifetime: 0 });

    // API 2: limit 10, cost 1, all markets
    const apiLimitsAll: WorkerLimits = { dailyLimit: 10, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerAll = new ApiWorker("API_ALL", "FAKE", new MockApiAdapter(), apiLimitsAll, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    // Scraper Worker: limit 50, cost 99, all markets (fallback)
    const scraperLimits: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("SCRAPER", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    dispatcher.registerWorker(apiWorkerIT);
    dispatcher.registerWorker(apiWorkerAll);
    dispatcher.registerWorker(scraperWorker);

    // Mock the delegateAndOrganizeTasks of each worker to capture tasks instead of doing actual timeline planning
    const allocatedTasks = new Map<BaseWorker, Task[]>();

    (apiWorkerIT as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(apiWorkerIT, tasks); };
    (apiWorkerAll as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(apiWorkerAll, tasks); };
    (scraperWorker as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(scraperWorker, tasks); };

    // Prevent executeDailyMission from actually running since we just want to test allocation
    (apiWorkerIT as any).executeDailyMission = async () => {};
    (apiWorkerAll as any).executeDailyMission = async () => {};
    (scraperWorker as any).executeDailyMission = async () => {};

    // Prevent flushing updates to DB
    (dispatcher as any).updater.flushPartialUpdates = async () => {};
    // Override workers to prevent loadAllWorkers from messing up the config
    (dispatcher as any).workers = [apiWorkerIT, apiWorkerAll, scraperWorker];

    // Stub out the WorkerFactory to prevent loading from config during the test
    const WorkerFactoryModule = require("../factory/WorkerFactory");
    WorkerFactoryModule.WorkerFactory.loadAllWorkers = async () => [];

    // Stub out the healthCheck to avoid DB issues
    (dispatcher as any).healthCheck = async () => true;

    console.log("Running Dispatcher run()...");
    await dispatcher.run();

    const apiItTasks = allocatedTasks.get(apiWorkerIT) || [];
    const apiAllTasks = allocatedTasks.get(apiWorkerAll) || [];
    const scraperTasks = allocatedTasks.get(scraperWorker) || [];

    console.log(`\nAllocation Results:`);
    console.log(`- API_IT tasks: ${apiItTasks.length} (Expected: 5)`);
    console.log(`- API_ALL tasks: ${apiAllTasks.length} (Expected: 10)`);
    console.log(`- SCRAPER tasks: ${scraperTasks.length} (Expected: 50)`);

    const totalTasks = apiItTasks.length + apiAllTasks.length + scraperTasks.length;
    console.log(`Total tasks allocated: ${totalTasks}`);

    // In actual logic we expect:
    // IT API handles 5 limit
    // ALL API handles 10 limit
    // SCRAPER handles 50 limit
    // Total handled = 65 tasks out of 120 requested.
    if (apiItTasks.length === 5 && apiAllTasks.length === 10 && scraperTasks.length === 50) {
        console.log("Dispatcher Allocation Test PASS: Tasks correctly factor in 4x weight per market.");
    } else {
        console.error("Dispatcher Allocation Test FAIL: Task distribution mismatch.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);
