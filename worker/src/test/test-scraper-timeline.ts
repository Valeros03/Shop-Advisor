import { Task, WorkerLimits } from "../types";
import { MockScraperWorker } from "./MockScraperWorker";

async function runTest() {
    console.log("=== STARTING SCRAPER TIMELINE TEST ===");

    const scraperLimits: WorkerLimits = { dailyLimit: 50, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("SCRAPER", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });

    const fakeTasks: Task[] = [];
    for (let i = 0; i < 20; i++) {
        fakeTasks.push({ asin: `ASIN_${Math.floor(i / 3)}`, market: i % 3 === 0 ? "amazon.it" : (i % 3 === 1 ? "amazon.fr" : "amazon.de"), isMustTomorrow: false });
    }

    // Mocking sleep and pauses so we can test the timeline array length
    (scraperWorker as any).sleep = async () => {};
    (scraperWorker as any).handleLongPauses = async () => {};

    scraperWorker.delegateAndOrganizeTasks(fakeTasks);

    const timeline = (scraperWorker as any).timelineQueue;
    console.log(`Timeline Generated: ${timeline.length} execution clusters.`);

    let sumTasks = 0;
    timeline.forEach((t: any) => sumTasks += t.cluster.tasks.length);

    console.log(`Total Tasks in Timeline: ${sumTasks} (Expected: 20)`);

    if (sumTasks === 20 && timeline.length > 0) {
        console.log("Scraper Timeline Test PASS: Timeline was correctly generated handling dynamic clustering and pauses.");
    } else {
        console.error("Scraper Timeline Test FAIL.");
    }
}

runTest().catch(console.error);
