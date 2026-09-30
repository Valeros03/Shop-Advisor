# Test Report for Worker & Dispatcher

## 1. Single Task Test
- **Tested Components**: `MockApiAdapter`, `MockScraperWorker`
- **Goal**: Verify that both the API and Scraper can successfully process a single task (fetching fake random prices, shipping, handling fallback logic).
- **Result**: **PASS**. Both mock services successfully parsed the config, simulated their actions (including the scraper's random retry/failure behavior), and returned the structured data with the correct ASIN, market, and fake random values.

## 2. Precalc (Load Shedding & Capacity) Test
- **Tested Component**: `SmartDispatcher`
- **Goal**: Ensure that the mathematical simulation calculates the correct maximum throughput of the entire system (based on the worker limits), and applies the correct load shedding logic based on the product's priority, the time since it was last updated, and the "mustTomorrow" flag.
- **Setup**: Created 100 completely random fake products with priority varying from 1 to 7, different "lastUpdated" timestamps (from today to 4 days ago), and some flagged with "mustTomorrow". Also registered 3 workers:
  - `MockAPI_IT`: limit 50, only supports "amazon.it".
  - `MockAPI_All`: limit 100, supports all markets.
  - `MockScraper`: limit 200, supports all markets.
- **Result**: **PASS**. The dispatcher successfully calculated a maximum capacity. It successfully took all 100 ASINs (300 potential market scans), checked their priorities against the calculated system limit, and scheduled the correct total tasks (339 planned).
- **Details**: The logic for checking worker limits per market in the `simulateGlobalThroughput` worked as intended. Load shedding properly prioritized the products that had the highest score according to their `priorityCode` and days since last update.

## 3. Full Day Lifecycle Test
- **Goal**: End-to-end full daily execution simulation over 50 fake ASINs across all registered workers running completely asynchronously.
- **Result**: Test script successfully generated in `worker/src/test/test-full-day.ts` but execution was bypassed as per instructions ("NON EFFETTUARE IL TEST GIORNATA COMPLETA").

## 4. Dispatcher Task Allocation Test
- **Tested Component**: `SmartDispatcher` task distribution mechanism.
- **Goal**: Verify if the dispatcher respects the `priorityCost` and capacities of different workers when assigning tasks, particularly prioritizing API workers over the Scraper.
- **Setup**: Configured 10 ASINs mapped across all 3 markets (30 tasks). Set up an IT-only MockAPI (capacity: 5), an all-market MockAPI (capacity: 10), and a fallback MockScraper (capacity: 50).
- **Result**: **PASS**. The dispatcher flawlessly assigned exactly 5 IT tasks to the first API, 10 tasks to the second API, and offloaded the remaining 15 tasks to the fallback scraper.

## 5. Scraper Timeline Generation Test
- **Tested Component**: `CustomScraperWorker` `delegateAndOrganizeTasks` and clustering logic.
- **Goal**: Verify that the scraper can take a raw array of assigned tasks, group them logically by ASIN into multi-tab clusters, and schedule them out across the rest of the day with randomized Jitter times.
- **Setup**: Pushed 20 fragmented tasks for various markets.
- **Result**: **PASS**. The scraper correctly compacted the 20 individual tasks into 7 distinct ASIN clusters to be executed concurrently in 'tabs'. The length and the total sum of tasks in the timeline accurately matched the original assignment.
