import { Task, WorkerResult, WorkerLimits, ApiAdapter, AmazonMarket, ProductRecord } from "./types";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { WorkerFactory } from "./factory/WorkerFactory";
import { ProductUpdater } from "./Updater";

import * as path from "path";
const { PrismaClient } = require(path.resolve(__dirname, "../../shop-advisor/node_modules/@prisma/client"));

// --- 1. BASE WORKER ---
export abstract class BaseWorker {
    public readonly type: 'api' | 'scraper';
    public readonly name: string;
    public readonly supportedMarkets: AmazonMarket[];
    protected limits: WorkerLimits;

    protected currentDailyUsage: number = 0;
    protected currentMonthlyUsage: number = 0;
    protected currentLifetimeUsage: number = 0;
    
    protected lastExecutionTime: number = 0;
    protected lastTaskPromise: Promise<void> = Promise.resolve();

    public abstract readonly priorityCost: number; 

    constructor(
        name: string, type: 'api' | 'scraper', limits: WorkerLimits, 
        supportedMarkets: AmazonMarket[], 
        initialUsage = { daily: 0, monthly: 0, lifetime: 0 }
    ) {
        this.name = name;
        this.type = type;
        this.limits = limits;
        this.supportedMarkets = supportedMarkets;
        this.currentDailyUsage = initialUsage.daily;
        this.currentMonthlyUsage = initialUsage.monthly;
        this.currentLifetimeUsage = initialUsage.lifetime;
    }

    public hasCapacity(): boolean {
        return this.getRemainingCapacity() > 0;
    }

    public getRemainingCapacity(): number {
        let remaining = this.limits.dailyLimit - this.currentDailyUsage;
        if (this.limits.monthlyLimit !== -1) {
            remaining = Math.min(remaining, this.limits.monthlyLimit - this.currentMonthlyUsage);
        }
        if (this.limits.lifetimeLimit !== -1) {
            remaining = Math.min(remaining, this.limits.lifetimeLimit - this.currentLifetimeUsage);
        }
        return Math.max(0, remaining);
    }

    public supportsMarket(market: AmazonMarket): boolean {
        return this.supportedMarkets.includes(market);
    }

    public reserveCapacity(): boolean {
        if (!this.hasCapacity()) return false;
        this.currentDailyUsage++;
        if (this.limits.monthlyLimit !== -1) this.currentMonthlyUsage++;
        if (this.limits.lifetimeLimit !== -1) this.currentLifetimeUsage++;
        return true;
    }

    protected async enforceRateLimit(): Promise<void> {
        if (!this.limits.rateLimitTps) return;
        const minIntervalMs = 1000 / this.limits.rateLimitTps;

        const waitPromise = this.lastTaskPromise.then(async () => {
            const now = Date.now();
            const timeSinceLastExecution = now - this.lastExecutionTime;
            if (timeSinceLastExecution < minIntervalMs) {
                await new Promise(resolve => setTimeout(resolve, minIntervalMs - timeSinceLastExecution));
            }
            this.lastExecutionTime = Date.now();
        }).catch(() => {
            this.lastExecutionTime = Date.now();
        });

        this.lastTaskPromise = waitPromise;
        await waitPromise;
    }

    public abstract setupVirtualSimulation(): void;
    public abstract consumeVirtualCurrency(isFirstTaskForAsin: boolean): boolean;
    
    public abstract delegateAndOrganizeTasks(tasks: Task[]): void;
    public abstract executeDailyMission(updater: ProductUpdater): Promise<void>;
}

// --- 2. API WORKER ---
interface ScheduledApiTask {
    targetTime: number;
    task: Task;
}

export class ApiWorker extends BaseWorker {
    public readonly priorityCost = 1; 
    private apiKey: string;
    private adapter: ApiAdapter;
    
    private virtualTokens: number = 0;
    private virtualDailyUsage: number = 0;
    private timelineQueue: ScheduledApiTask[] = [];

    constructor(
        name: string, apiKey: string, adapter: ApiAdapter,
        limits: WorkerLimits, supportedMarkets: AmazonMarket[],
        initialUsage = { daily: 0, monthly: 0, lifetime: 0 }
    ) {
        super(name, "api", limits, supportedMarkets, initialUsage);
        this.apiKey = apiKey;
        this.adapter = adapter;
    }

    public setupVirtualSimulation(): void {
        let maxTokens = this.getRemainingCapacity();
        if (this.limits.rateLimitTps && this.limits.rateLimitTps > 0) {
            const activeSeconds = 17 * 3600;
            maxTokens = Math.min(maxTokens, activeSeconds * this.limits.rateLimitTps);
        }
        this.virtualTokens = maxTokens;
        this.virtualDailyUsage = this.currentDailyUsage;
    }

    public consumeVirtualCurrency(isFirstTaskForAsin: boolean): boolean {
        if (this.limits.dailyLimit !== -1 && this.virtualDailyUsage >= this.limits.dailyLimit) {
            return false;
        }
        if (this.virtualTokens > 0) {
            this.virtualTokens -= 1;
            this.virtualDailyUsage++;
            return true;
        }
        return false;
    }

    public delegateAndOrganizeTasks(assignedTasks: Task[]): void {
        console.log(`[API - ${this.name}] Pianificazione di ${assignedTasks.length} task lungo la timeline...`);
        const now = Date.now();
        const endOfDay = new Date().setHours(23, 59, 59, 999);
        this.timelineQueue = [];

        // Rispettiamo il targetSlotTime imposto a monte dal Dispatcher
        assignedTasks.forEach((task) => {
            const baseTime = task.targetSlotTime ?? now;
            // Jitter leggero (±30s) per non creare richieste in simultanea esatta
            const jitter = (Math.random() * 60000) - 30000;
            const targetTime = Math.min(Math.max(baseTime + jitter, now), endOfDay - 1000);
            this.timelineQueue.push({ targetTime, task });
        });

        this.timelineQueue.sort((a, b) => a.targetTime - b.targetTime);
    }

    public async executeDailyMission(updater: ProductUpdater): Promise<void> {
        while (this.timelineQueue.length > 0) {
            const scheduledJob = this.timelineQueue.shift()!;
            
            const msUntilTarget = scheduledJob.targetTime - Date.now();
            if (msUntilTarget > 0) {
                await new Promise(resolve => setTimeout(resolve, msUntilTarget));
            }

            await this.enforceRateLimit();

            try {
                const config = this.adapter.buildRequestConfig(scheduledJob.task, this.apiKey);
                const response = await axios(config);
                const normalizedData = this.adapter.extractData(response.data);

                await updater.submitResult(scheduledJob.task.asin, scheduledJob.task.market, {
                    success: true, timestamp: new Date(), data: normalizedData 
                });
            } catch (error: any) {
                await updater.submitResult(
                    task.asin, 
                    task.market, 
                    result, 
                    task.cycleIndex ?? 0
                );
            }
        }
        console.log(`[API - ${this.name}] 🏁 Chiusura ciclo giornaliero.`);
    }
}

// --- 3. SMART DISPATCHER ---
interface DispatcherProductRecord extends ProductRecord {
    isUserTracked: boolean;
}

export class SmartDispatcher {
    private prisma: PrismaClient;
    private updater: ProductUpdater;
    private workers: BaseWorker[] = [];
    private MARKETS: AmazonMarket[] = ["amazon.it", "amazon.fr", "amazon.de"];

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
        this.updater = new ProductUpdater(prisma);
    }

    public registerWorker(worker: BaseWorker) {
        this.workers.push(worker);
    }

    public async healthCheck(): Promise<boolean> {
        try { await this.prisma.$queryRaw`SELECT 1`; } 
        catch { return false; }
        return this.workers.length > 0;
    }

    private simulateGlobalThroughput(): number {
        const sortedWorkers = [...this.workers].sort((a, b) => a.priorityCost - b.priorityCost);
        sortedWorkers.forEach(w => w.setupVirtualSimulation());

        let maxCycles = 0;

        while (true) {
            let cycleFullyAllocated = true;
            const workersUsedForThisCycle = new Set<BaseWorker>();

            for (const market of this.MARKETS) {
                let taskAllocated = false;
                
                for (const worker of sortedWorkers) {
                    if (worker.supportsMarket(market)) {
                        const isFirstTaskForCycle = !workersUsedForThisCycle.has(worker);
                        
                        if (worker.consumeVirtualCurrency(isFirstTaskForCycle)) {
                            taskAllocated = true;
                            workersUsedForThisCycle.add(worker);
                            break; 
                        }
                    }
                }
                
                if (!taskAllocated) {
                    cycleFullyAllocated = false;
                    break;
                }
            }

            if (cycleFullyAllocated) {
                maxCycles++;
            } else {
                break;
            }
        }
        
        console.log(`[Dispatcher] 🎯 Capacità Massima calcolata: ${maxCycles} Cicli Completi.`);
        return maxCycles;
    }

    private calculateUrgencyScore(product: DispatcherProductRecord): number {
        const daysSinceUpdate = (Date.now() - product.lastUpdated.getTime()) / (1000 * 3600 * 24);
        let score = daysSinceUpdate / product.priorityCode;

        if (product.isUserTracked && product.mustTomorrow) score += 30000;
        else if (product.isUserTracked && !product.mustTomorrow) score += 20000;
        else if (!product.isUserTracked && product.mustTomorrow) score += 10000;

        return score;
    }

    public async planDailyTasks(products: DispatcherProductRecord[], maxCycles: number): Promise<Task[]> {
        let plannedUpdates: { product: DispatcherProductRecord; updatesCount: number }[] = [];
        const today = new Date();

        for (const p of products) {
            let updatesToday = 0;
            const daysSinceUpdate = Math.floor((today.getTime() - p.lastUpdated.getTime()) / (1000 * 3600 * 24));

            if (p.mustTomorrow) {
                updatesToday = 1;
            } else {
                switch (p.priorityCode) {
                    case 1: updatesToday = 4; break;
                    case 2: updatesToday = 2; break;
                    case 3: if (daysSinceUpdate >= 1) updatesToday = 1; break;
                    case 4: if (daysSinceUpdate >= 2) updatesToday = 1; break;
                    case 5: if (daysSinceUpdate >= 5) updatesToday = 1; break;
                    case 6: if (daysSinceUpdate >= 7) updatesToday = 1; break;
                    case 7: if (daysSinceUpdate >= 12) updatesToday = 1; break;
                }
            }
            if (updatesToday > 0) plannedUpdates.push({ product: p, updatesCount: updatesToday });
        }

        return await this.applyLoadShedding(plannedUpdates, maxCycles);
    }

    private async applyLoadShedding(planned: { product: DispatcherProductRecord; updatesCount: number }[], maxCycles: number): Promise<Task[]> {
        const initialRequested = planned.reduce((sum, p) => sum + p.updatesCount, 0);
        let totalCyclesRequested = initialRequested;
        let tasksToMarkMustTomorrow: string[] = [];

        console.log(`\n[Load Shedding] 📊 Inizio bilanciamento carico:`);
        console.log(`- Capacità massima (maxCycles): ${maxCycles} cicli completi (${maxCycles * 3} task atomici)`);
        console.log(`- Richiesta iniziale: ${totalCyclesRequested} cicli (${totalCyclesRequested * 3} task atomici) da ${planned.length} prodotti.`);

        // FASE A: Taglio degli update multipli
        let multiCuts = 0;
        while (totalCyclesRequested > maxCycles) {
            const multiUpdateProducts = planned.filter(p => p.updatesCount > 1);
            if (multiUpdateProducts.length === 0) break;
            multiUpdateProducts.sort((a, b) => this.calculateUrgencyScore(a.product) - this.calculateUrgencyScore(b.product));
            multiUpdateProducts[0].updatesCount--;
            totalCyclesRequested--;
            multiCuts++;
        }
        if (multiCuts > 0) {
            console.log(`- [Fase A] Tagliati ${multiCuts} aggiornamenti multipli sui prodotti meno urgenti.`);
        }

        // FASE B: Taglio interi prodotti
        let droppedProducts = 0;
        if (totalCyclesRequested > maxCycles) {
            planned.sort((a, b) => this.calculateUrgencyScore(a.product) - this.calculateUrgencyScore(b.product));
            for (let i = 0; i < planned.length; i++) {
                if (totalCyclesRequested <= maxCycles) break;
                totalCyclesRequested -= planned[i].updatesCount;
                planned[i].updatesCount = 0;
                tasksToMarkMustTomorrow.push(planned[i].product.asin);
                droppedProducts++;
            }
            console.log(`- [Fase B] Rimossi interamente ${droppedProducts} prodotti.`);
        }

        // FASE C: Backfill slot vuoti
        let backfilledCycles = 0;
        if (totalCyclesRequested < maxCycles) {
            const activeProducts = planned.filter(p => p.updatesCount > 0);
            activeProducts.sort((a, b) => this.calculateUrgencyScore(b.product) - this.calculateUrgencyScore(a.product));

            for (const p of activeProducts) {
                if (totalCyclesRequested >= maxCycles) break;
                if (p.updatesCount < 4) {
                    p.updatesCount++;
                    totalCyclesRequested++;
                    backfilledCycles++;
                }
            }
            if (backfilledCycles > 0) {
                console.log(`- [Fase C - Ottimizzazione] 🎯 Recuperati ${backfilledCycles} slot liberi.`);
            }
        }

        console.log(`- Bilanciamento completato: ${totalCyclesRequested}/${maxCycles} cicli saturati.\n`);

        if (tasksToMarkMustTomorrow.length > 0) {
            await this.prisma.product.updateMany({
                where: { asin: { in: tasksToMarkMustTomorrow } },
                data: { mustTomorrow: true }
            });
        }

        // --- FASE D: CALCOLO DELLE 4 MACRO-ONDATE GLOBALI & INTERLEAVING ---
        const now = Date.now();
        const midnight = new Date();
        midnight.setHours(23, 59, 59, 999);
        const totalWindowMs = Math.max(midnight.getTime() - now, 60000);

        // Definiamo 4 Macro-Fasce orarie costanti
        const NUM_WAVES = 4;
        const waveDurationMs = totalWindowMs / NUM_WAVES;

        // Prepariamo i contenitori per i cicli completi in ogni ondata
        const waveBuckets: { asin: string; isMustTomorrow: boolean; cycleIndex: number }[][] = [[], [], [], []];

        let singleUpdateCounter = 0;

        for (const p of planned) {
            if (p.updatesCount <= 0) continue;
            this.updater.registerExpectation(item.asin, this.MARKETS, item.cycleIndex);

            if (p.updatesCount === 4) {
                // Un ciclo per ciascuna delle 4 fasce
                for (let c = 0; c < 4; c++) waveBuckets[c].push({ asin: p.product.asin, isMustTomorrow: p.product.mustTomorrow, cycleIndex: c });
            } else if (p.updatesCount === 3) {
                // Fasce 0, 1 e 3 (distanziate)
                [0, 1, 3].forEach((w, cIdx) => waveBuckets[w].push({ asin: p.product.asin, isMustTomorrow: p.product.mustTomorrow, cycleIndex: cIdx }));
            } else if (p.updatesCount === 2) {
                // Fasce 0 e 2 (mattina/pomeriggio e sera)
                [0, 2].forEach((w, cIdx) => waveBuckets[w].push({ asin: p.product.asin, isMustTomorrow: p.product.mustTomorrow, cycleIndex: cIdx }));
            } else if (p.updatesCount === 1) {
                // INTERLEAVING: Distribuisce i prodotti a singolo ciclo equamente nelle 4 fasce
                const targetWave = singleUpdateCounter % NUM_WAVES;
                waveBuckets[targetWave].push({ asin: p.product.asin, isMustTomorrow: p.product.mustTomorrow, cycleIndex: 0 });
                singleUpdateCounter++;
            }
        }

        // Generazione finale dei Task atomici ordinati per targetSlotTime
        const finalTasks: Task[] = [];

        for (let w = 0; w < NUM_WAVES; w++) {
            const bucket = waveBuckets[w];
            if (bucket.length === 0) continue;

            const waveStartTime = now + (w * waveDurationMs);
            const stepMs = waveDurationMs / bucket.length;

            bucket.forEach((item, idx) => {
                const targetSlotTime = Math.min(
                    waveStartTime + (idx * stepMs),
                    midnight.getTime() - 2000
                );

                for (const market of this.MARKETS) {
                    finalTasks.push({
                        asin: item.asin,
                        market,
                        isMustTomorrow: item.isMustTomorrow,
                        cycleIndex: item.cycleIndex,
                        targetSlotTime
                    });
                }
            });
        }

        return finalTasks;
    }

    private selectWorkerForTask(task: Task): BaseWorker | null {
        const eligibleWorkers = this.workers.filter(w => w.supportsMarket(task.market) && w.hasCapacity());
        if (eligibleWorkers.length === 0) return null;
        eligibleWorkers.sort((a, b) => a.priorityCost - b.priorityCost);
        return eligibleWorkers[0];
    }

    public async run(): Promise<void> {
        console.log("[Dispatcher] 🚀 Avvio pianificazione giornaliera...");

        const loadedWorkers = await (await import("./factory/WorkerFactory")).WorkerFactory.loadAllWorkers();
        loadedWorkers.forEach(w => { if (!this.workers.some(existing => existing.name === w.name)) { this.registerWorker(w); } });

        if (!(await this.healthCheck())) return;

        const maxCyclesToday = this.simulateGlobalThroughput();

        const rawProducts = await this.prisma.product.findMany({
            select: {
                id: true, asin: true, priorityCode: true, mustTomorrow: true, lastUpdated: true,
                _count: { select: { alerts: { where: { isActive: true } } } }
            }
        });

        const products: DispatcherProductRecord[] = rawProducts.map(p => ({
            id: p.id, asin: p.asin, priorityCode: p.priorityCode, mustTomorrow: p.mustTomorrow,
            lastUpdated: p.lastUpdated, isUserTracked: p._count.alerts > 0
        }));

        const tasks = await this.planDailyTasks(products, maxCyclesToday);

        const taskMap = new Map<BaseWorker, Task[]>();
        for (const w of this.workers) taskMap.set(w, []);

        for (const task of tasks) {
            const worker = this.selectWorkerForTask(task);
            if (worker && worker.reserveCapacity()) {
                taskMap.get(worker)!.push(task);
            } else {
                console.warn(`[Dispatcher] ⚠️ Impossibile allocare il task ${task.asin} su ${task.market}. (Le capacità reali non combaciano con la simulazione)`);
            }
        }

        const missionPromises = [];
        for (const [worker, assignedTasks] of taskMap.entries()) {
            if (assignedTasks.length > 0) {
                worker.delegateAndOrganizeTasks(assignedTasks);
                missionPromises.push(worker.executeDailyMission(this.updater));
            }
        }

        await Promise.all(missionPromises);
        await this.updater.flushPartialUpdates();
        console.log("[Dispatcher] 🌌 Giornata completata con successo.");
    }
}