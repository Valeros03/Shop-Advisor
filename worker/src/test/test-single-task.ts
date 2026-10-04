import { PrismaClient } from "@prisma/client";
import { MockScraperWorker } from "./MockScraperWorker";
import { MockApiAdapter } from "./MockApiAdapter";
import { Task, WorkerLimits } from "../types";

async function runTest() {
    console.log("=== STARTING SINGLE TASK TEST ===");

    const task: Task = { asin: "B08N5WRWNW", market: "amazon.it", isMustTomorrow: false };

    console.log("1. Testing Mock API Adapter...");
    const apiAdapter = new MockApiAdapter();
    const config = apiAdapter.buildRequestConfig(task, "FAKE_KEY");

    const rawResponse = { asin: task.asin, market: task.market, product_results: { extracted_price: 25.99 } };
    const apiData = apiAdapter.extractData(rawResponse);
    console.log("Mock API Result:", apiData);
    if (!apiData.price) throw new Error("API Adapter failed to extract price");

    console.log("2. Testing Mock Scraper Worker...");
    const scraperLimits: WorkerLimits = { dailyLimit: 10, monthlyLimit: -1, lifetimeLimit: -1, rateLimitTps: null };
    const scraperWorker = new MockScraperWorker("MockScraper", scraperLimits, ["amazon.it", "amazon.fr", "amazon.de"], { daily: 0, monthly: 0, lifetime: 0 });
    const scraperResult = await scraperWorker.testExecute(task);
    console.log("Mock Scraper Result:", scraperResult);
    if (!scraperResult.success && scraperResult.error !== "MOCK_NETWORK_FAILURE") {
         throw new Error("Scraper failed for unexpected reason");
    }

    console.log("Single task test successful!");
}

runTest().catch(console.error);
