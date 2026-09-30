// worker.ts
import { Task, WorkerResult, WorkerLimits, ApiAdapter, AmazonMarket, ProductRecord } from "./types";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { WorkerFactory } from "./factory/WorkerFactory";
import { ProductUpdater } from "./updater";

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

    // Priorità: le API hanno 1 (vengono riempite per prime dal Dispatcher), lo Scraper 99
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

    // Riserva Sincrona Atomica (eseguita solo alle 07:00)
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

    // Interfacce per la simulazione matematica delle 00:15 / 07:00
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
        // La capacità dell'API per la simulazione è il suo limite giornaliero incrociato col TPS
        let maxTokens = this.getRemainingCapacity();
        if (this.limits.rateLimitTps && this.limits.rateLimitTps > 0) {
            const activeSeconds = 17 * 3600; // 07:00 - 00:00
            maxTokens = Math.min(maxTokens, activeSeconds * this.limits.rateLimitTps);
        }
        this.virtualTokens = maxTokens;
    }

    public consumeVirtualCurrency(isFirstTaskForAsin: boolean): boolean {
        // L'API non fa pause, costa sempre 1 token per ogni task
        if (this.virtualTokens > 0) {
            this.virtualTokens -= 1;
            return true;
        }
        return false;
    }

    public delegateAndOrganizeTasks(assignedTasks: Task[]): void {
        console.log(`[API - ${this.name}] Pianificazione di ${assignedTasks.length} task...`);
        
        const tasksByAsin = new Map<string, Task[]>();
        for (const task of assignedTasks) {
            if (!tasksByAsin.has(task.asin)) tasksByAsin.set(task.asin, []);
            tasksByAsin.get(task.asin)!.push(task);
        }

        const now = Date.now();
        const endOfDay = new Date().setHours(23, 59, 59, 999);
        const totalWindowMs = endOfDay - now;

        this.timelineQueue = [];

        for (const [asin, tasks] of tasksByAsin.entries()) {
            const bucketSizeMs = totalWindowMs / tasks.length;
            tasks.forEach((task, index) => {
                // Jitter minimo per evitare spike simultanei
                const jitter = Math.random() * (bucketSizeMs * 0.1); 
                const targetTime = now + (index * bucketSizeMs) + jitter;
                this.timelineQueue.push({ targetTime, task });
            });
        }
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

                await updater.submitResult(scheduledJob.task, { 
                    success: true, timestamp: new Date(), data: normalizedData 
                });
            } catch (error: any) {
                await updater.submitResult(scheduledJob.task, { 
                    success: false, error: error.message, timestamp: new Date() 
                });
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

    // --- LA SIMULAZIONE MATEMATICA DEL MATTINO ---
    private simulateGlobalThroughput(): number {
        // Le API verranno testate per prime perché costano meno (priorityCost = 1)
        const sortedWorkers = [...this.workers].sort((a, b) => a.priorityCost - b.priorityCost);
        sortedWorkers.forEach(w => w.setupVirtualSimulation());

        let maxCompleteProducts = 0;

        while (true) {
            let productFullyAllocated = true;
            // Per tenere traccia se lo Scraper ha già pagato la "Macro-Pausa" per l'ASIN corrente
            const workersUsedForThisAsin = new Set<BaseWorker>();

            for (const market of this.MARKETS) {
                let taskAllocated = false;
                
                for (const worker of sortedWorkers) {
                    if (worker.supportsMarket(market)) {
                        const isFirstTaskForAsin = !workersUsedForThisAsin.has(worker);
                        
                        // Scala la valuta virtuale (Gettoni per le API, Secondi esatti per lo Scraper)
                        if (worker.consumeVirtualCurrency(isFirstTaskForAsin)) {
                            taskAllocated = true;
                            workersUsedForThisAsin.add(worker);
                            break; 
                        }
                    }
                }
                
                // Se c'è anche un solo mercato che nessuno ha le risorse per fare, il prodotto è zoppo.
                if (!taskAllocated) {
                    productFullyAllocated = false;
                    break;
                }
            }

            if (productFullyAllocated) {
                maxCompleteProducts++;
            } else {
                break; // Il limite globale dell'ecosistema è stato raggiunto.
            }
        }
        
        console.log(`[Dispatcher] 🎯 Capacità Massima calcolata: ${maxCompleteProducts} Prodotti Completi.`);
        return maxCompleteProducts;
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
        let totalCyclesRequested = planned.reduce((sum, p) => sum + p.updatesCount, 0);
        let tasksToMarkMustTomorrow: string[] = [];

        // FASE A: Taglio degli update multipli
        while (totalCyclesRequested > maxCycles) {
            const multiUpdateProducts = planned.filter(p => p.updatesCount > 1);
            if (multiUpdateProducts.length === 0) break;
            multiUpdateProducts.sort((a, b) => this.calculateUrgencyScore(a.product) - this.calculateUrgencyScore(b.product));
            multiUpdateProducts[0].updatesCount--;
            totalCyclesRequested--;
        }

        // FASE B: Taglio interi prodotti
        if (totalCyclesRequested > maxCycles) {
            planned.sort((a, b) => this.calculateUrgencyScore(a.product) - this.calculateUrgencyScore(b.product));
            for (let i = 0; i < planned.length; i++) {
                if (totalCyclesRequested <= maxCycles) break;
                totalCyclesRequested -= planned[i].updatesCount;
                planned[i].updatesCount = 0;
                tasksToMarkMustTomorrow.push(planned[i].product.asin);
            }
        }

        if (tasksToMarkMustTomorrow.length > 0) {
            console.warn(`[Dispatcher] Load Shedding: Rimandati ${tasksToMarkMustTomorrow.length} ASIN a domani.`);
            await this.prisma.product.updateMany({
                where: { asin: { in: tasksToMarkMustTomorrow } },
                data: { mustTomorrow: true }
            });
        }

        // ESPANSIONE DEI TASK: 1 Prodotto in 3 Task separati
        const finalTasks: Task[] = [];
        for (const p of planned) {
            if (p.updatesCount <= 0) continue;
            
            // L'Updater viene informato che si aspetta 3 risultati
            this.updater.registerExpectation(p.product.asin, this.MARKETS);

            for (let i = 0; i < p.updatesCount; i++) {
                for (const market of this.MARKETS) {
                    finalTasks.push({ asin: p.product.asin, market: market, isMustTomorrow: p.product.mustTomorrow });
                }
            }
        }
        return finalTasks;
    }

    // --- LA DELEGAZIONE UNICA DELLE 07:00 ---
    private selectWorkerForTask(task: Task): BaseWorker | null {
        // Seleziona chi supporta il mercato e ha capacità residua reale
        const eligibleWorkers = this.workers.filter(w => w.supportsMarket(task.market) && w.hasCapacity());
        if (eligibleWorkers.length === 0) return null;

        // Verrà sempre selezionata l'API (Priority 1) se disponibile e capiente. Lo Scraper (Priority 99) è il fallback.
        eligibleWorkers.sort((a, b) => a.priorityCost - b.priorityCost);
        return eligibleWorkers[0];
    }

    public async run(): Promise<void> {
        console.log("[Dispatcher] 🚀 Avvio pianificazione giornaliera...");

        const loadedWorkers = await WorkerFactory.loadAllWorkers();
        loadedWorkers.forEach(w => this.registerWorker(w));

        if (!(await this.healthCheck())) return;

        // 1. Simula per trovare il tetto esatto
        const maxCyclesToday = this.simulateGlobalThroughput();

        // 2. Estrazione dati dal DB
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

        // 3. Load Shedding esatto
        const tasks = await this.planDailyTasks(products, maxCyclesToday);

        // 4. DISTRIBUZIONE DEI TASK (Una volta per tutte)
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

        // 5. I WORKER PARTONO E GESTISCONO LE LORO TIMELINE
        const missionPromises = [];
        for (const [worker, assignedTasks] of taskMap.entries()) {
            if (assignedTasks.length > 0) {
                // Il worker si organizza l'intera giornata...
                worker.delegateAndOrganizeTasks(assignedTasks);
                // ... e parte in totale indipendenza.
                missionPromises.push(worker.executeDailyMission(this.updater));
            }
        }

        await Promise.all(missionPromises);
        
        // Alla fine della giornata, se ci sono risultati orfani o zoppi nella RAM dell'updater, li salva forzatamente.
        await this.updater.flushPartialUpdates();
        console.log("[Dispatcher] 🌌 Giornata completata con successo.");
    }
}