import { Task, WorkerLimits } from "../types";
import { MockScraperWorker } from "./MockScraperWorker";

async function runTest() {
    console.log("=== STARTING SCRAPER ADVANCED TIMELINE TEST ===");

    const scraperLimits: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("SCRAPER", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    const fakeTasks: Task[] = [];
    
    // Scenario realistico:
    // - ASIN_0: chiede 2 aggiornamenti completi (6 task totali)
    // - ASIN_1: chiede 2 aggiornamenti completi (6 task totali)
    // - ASIN_2: chiede 1 aggiornamento su 2 mercati (2 task totali)
    // - ASIN_3: chiede 1 aggiornamento singolo mercato (1 task)
    // Totale: 15 task
    for (let cycle = 0; cycle < 2; cycle++) {
        fakeTasks.push({ asin: "ASIN_0", market: "amazon.it", isMustTomorrow: false });
        fakeTasks.push({ asin: "ASIN_0", market: "amazon.fr", isMustTomorrow: false });
        fakeTasks.push({ asin: "ASIN_0", market: "amazon.de", isMustTomorrow: false });

        fakeTasks.push({ asin: "ASIN_1", market: "amazon.it", isMustTomorrow: false });
        fakeTasks.push({ asin: "ASIN_1", market: "amazon.fr", isMustTomorrow: false });
        fakeTasks.push({ asin: "ASIN_1", market: "amazon.de", isMustTomorrow: false });
    }
    fakeTasks.push({ asin: "ASIN_2", market: "amazon.it", isMustTomorrow: false });
    fakeTasks.push({ asin: "ASIN_2", market: "amazon.de", isMustTomorrow: false });
    fakeTasks.push({ asin: "ASIN_3", market: "amazon.it", isMustTomorrow: false });

    (scraperWorker as any).sleep = async () => {};
    (scraperWorker as any).handleLongPauses = async () => {};

    scraperWorker.delegateAndOrganizeTasks(fakeTasks);

    const timeline = (scraperWorker as any).timelineQueue;
    console.log(`\nTimeline creata: ${timeline.length} cluster esecutivi totali.`);

    // 1. Verifica integrità task
    let totalTasksScheduled = 0;
    timeline.forEach((item: any) => totalTasksScheduled += item.cluster.tasks.length);
    console.log(`- Totale task schedulati: ${totalTasksScheduled} (Previsti: 15)`);

    // 2. Verifica raggruppamento veloce: nessun mercato duplicato nello stesso cluster
    let noDuplicateMarketsInCluster = true;
    timeline.forEach((item: any) => {
        const markets = item.cluster.tasks.map((t: any) => t.market);
        const uniqueMarkets = new Set(markets);
        if (markets.length !== uniqueMarkets.size) noDuplicateMarketsInCluster = false;
    });
    console.log(`- Mercati dello stesso ASIN raggruppati senza collisioni: ${noDuplicateMarketsInCluster ? "OK" : "FAIL"}`);

    // 3. Verifica distanziamento tra primo e secondo aggiornamento dello stesso ASIN
    const asin0Clusters = timeline.filter((item: any) => item.cluster.asin === "ASIN_0");
    let isAsinIntervalWide = false;
    if (asin0Clusters.length === 2) {
        const diffMinutes = (asin0Clusters[1].targetTime - asin0Clusters[0].targetTime) / (1000 * 60);
        console.log(`- Distanza temporale tra aggiornamento #1 e #2 di ASIN_0: ${diffMinutes.toFixed(1)} minuti.`);
        isAsinIntervalWide = diffMinutes > 60; // Devono essere distanti almeno un'ora
    }

    console.log("\nEstratto Pianificazione Temporale:");
    timeline.forEach((item: any, idx: number) => {
        const dateStr = new Date(item.targetTime).toLocaleTimeString();
        const markets = item.cluster.tasks.map((t: any) => t.market.replace('amazon.', '')).join(', ');
        console.log(`  ${idx + 1}. [${dateStr}] ASIN: ${item.cluster.asin} -> Mercati eseguiti insieme: [${markets}]`);
    });

    if (totalTasksScheduled === 15 && noDuplicateMarketsInCluster && isAsinIntervalWide) {
        console.log("\n✅ Scraper Timeline Test PASS: Raggruppamento atomico e distanziamento inter-ciclo confermati.");
    } else {
        console.error("\n❌ Scraper Timeline Test FAIL.");
    }
}

runTest().catch(console.error);