import { PrismaClient } from "@prisma/client";
import { SmartDispatcher, ApiWorker } from "../worker";
import { MockScraperWorker } from "./MockScraperWorker";
import { MockApiAdapter } from "./MockApiAdapter";
import { WorkerLimits } from "../types";

const prisma = new PrismaClient();

async function runTest() {
    console.log("=== STARTING PRECALC TEST WITH 100 FAKE ASINS ===");

    // 1. Pulizia e Seed
    await prisma.product.deleteMany({});

    for (let i = 0; i < 100; i++) {
        await prisma.product.create({
            data: {
                asin: `ASIN_${i}`,
                name: `Test Product ${i}`,
                image: "http://example.com/img.jpg",
                priorityCode: (i % 7) + 1,
                mustTomorrow: i % 5 === 0,
                lastUpdated: new Date(Date.now() - 1000 * 60 * 60 * 24 * (i % 5)),
            }
        });
    }

    const dispatcher = new SmartDispatcher(prisma);

    // 2. Configurazione Worker
    const apiLimitsIT: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerIT = new ApiWorker("MockAPI_IT", "FAKE_KEY", new MockApiAdapter(), apiLimitsIT, ["amazon.it"], { daily: 0, monthly: 0, lifetime: 0 });

    const apiLimitsAll: WorkerLimits = { dailyLimit: 100, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const apiWorkerAll = new ApiWorker("MockAPI_All", "FAKE_KEY", new MockApiAdapter(), apiLimitsAll, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    const scraperLimits: WorkerLimits = { dailyLimit: 200, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("MockScraper", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    dispatcher.registerWorker(apiWorkerIT);
    dispatcher.registerWorker(apiWorkerAll);
    dispatcher.registerWorker(scraperWorker);

    // 3. Estrazione Record
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

    // 4. Simulazione Throughput (Nessun parametro richiesto)
    const maxCycles = (dispatcher as any).simulateGlobalThroughput();
    console.log(`\n[Test]Cicli completi massimi calcolati (maxCycles): ${maxCycles}`);

    // 5. Pianificazione Task: si passa maxCycles (NON moltiplicato per 3!)
    const tasks = await dispatcher.planDailyTasks(dispatcherProducts, maxCycles);
    console.log(`[Test]Totale Task atomici pianificati: ${tasks.length}`);

    // 6. Asserzioni di correttezza
    const maxAllowedTasks = maxCycles * 3;
    const isMultipleOfThree = tasks.length % 3 === 0;
    const isWithinBudget = tasks.length <= maxAllowedTasks;
    const hasGeneratedTasks = tasks.length > 0;

    console.log(`\n--- Verifiche di Integrità ---`);
    console.log(`- Task generati > 0: ${hasGeneratedTasks ? "OK" : "FAIL"}`);
    console.log(`- Multiplo esatto di 3 mercati: ${isMultipleOfThree ? "OK" : "FAIL"} (${tasks.length} % 3 == 0)`);
    console.log(`- Rispetto tetto massimo: ${isWithinBudget ? "OK" : "FAIL"} (${tasks.length} <= ${maxAllowedTasks})`);

    if (hasGeneratedTasks && isMultipleOfThree && isWithinBudget) {
        console.log("\nPrecalc test PASSED con successo!");
    } else {
        console.error("\nPrecalc test FAILED: anomalie nella pianificazione dei task.");
    }

    await prisma.$disconnect();
}

runTest().catch(console.error);