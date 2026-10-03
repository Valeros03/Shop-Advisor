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
    // Total requested tasks = 10 products * 4 cycles * 3 markets = 120 atomic tasks.
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

    // Scraper Worker: limit 45, cost 99, all markets (fallback)
    // 5 (IT) + 10 (ALL) + 45 (SCRAPER) = 60 task esatti = 20 cicli completi su 3 mercati
    const scraperLimits: WorkerLimits = { dailyLimit: 61, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("SCRAPER", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    dispatcher.registerWorker(apiWorkerIT);
    dispatcher.registerWorker(apiWorkerAll);
    dispatcher.registerWorker(scraperWorker);

    // Mock delegateAndOrganizeTasks
    const allocatedTasks = new Map<BaseWorker, Task[]>();
    (apiWorkerIT as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(apiWorkerIT, tasks); };
    (apiWorkerAll as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(apiWorkerAll, tasks); };
    (scraperWorker as any).delegateAndOrganizeTasks = (tasks: Task[]) => { allocatedTasks.set(scraperWorker, tasks); };

    // Prevent actual network executions
    (apiWorkerIT as any).executeDailyMission = async () => {};
    (apiWorkerAll as any).executeDailyMission = async () => {};
    (scraperWorker as any).executeDailyMission = async () => {};
    (dispatcher as any).updater.flushPartialUpdates = async () => {};
    (dispatcher as any).workers = [apiWorkerIT, apiWorkerAll, scraperWorker];

    // Stub factory and health check
    const WorkerFactoryModule = require("../factory/WorkerFactory");
    WorkerFactoryModule.WorkerFactory.loadAllWorkers = async () => [];
    (dispatcher as any).healthCheck = async () => true;

    console.log("Running Dispatcher run()...");
    await dispatcher.run();

    const apiItTasks = allocatedTasks.get(apiWorkerIT) || [];
    const apiAllTasks = allocatedTasks.get(apiWorkerAll) || [];
    const scraperTasks = allocatedTasks.get(scraperWorker) || [];

    const totalTasks = apiItTasks.length + apiAllTasks.length + scraperTasks.length;
    const maxPossibleCapacity = apiLimitsIT.dailyLimit + apiLimitsAll.dailyLimit + scraperLimits.dailyLimit;

    console.log(`\nAllocation Results:`);
    console.log(`- API_IT tasks: ${apiItTasks.length} / max ${apiLimitsIT.dailyLimit}`);
    console.log(`- API_ALL tasks: ${apiAllTasks.length} / max ${apiLimitsAll.dailyLimit}`);
    console.log(`- SCRAPER tasks: ${scraperTasks.length} / max ${scraperLimits.dailyLimit}`);
    console.log(`Total tasks allocated: ${totalTasks} (Capacità teorica massima: ${maxPossibleCapacity})`);

    // VERIFICHE DI CORRETTEZZA ARCHITETTURALE:
    // 1. Nessun worker supera il proprio budget massimo
    const limitsRespected = 
        apiItTasks.length <= apiLimitsIT.dailyLimit &&
        apiAllTasks.length <= apiLimitsAll.dailyLimit &&
        scraperTasks.length <= scraperLimits.dailyLimit;

    // 2. Tutti i cicli sono completi (multipli di 3 mercati)
    const isMultiMarketCycleValid = totalTasks % 3 === 0;

    // 3. I gettoni scartati sono solo quelli 'spaiati' che non potevano chiudere un ciclo da 3
    const unusedCapacity = maxPossibleCapacity - totalTasks;
    const noWastedCycles = unusedCapacity < 3;

    if (limitsRespected && isMultiMarketCycleValid && noWastedCycles) {
        console.log(`Dispatcher Allocation Test PASS: ${totalTasks / 3} cicli completi allocati. Rimasti solo ${unusedCapacity} gettoni spaiati (fisiologico).`);
    } else {
        console.error("Dispatcher Allocation Test FAIL: Distribuzione incoerente o cicli rotti.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);