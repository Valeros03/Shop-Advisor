import { Task, WorkerResult, WorkerLimits, ApiAdapter, AmazonMarket, ProductRecord } from "./types";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { WorkerFactory } from "./factory/WorkerFactory";
import { ProductUpdater } from "./Updater";
import { notifier } from "./service/NotificationService";

import * as path from "path";
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

    private isPastMidnight(): boolean {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Rome',
            hour: 'numeric',
            hour12: false
        }).formatToParts(new Date());
        const hour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
        return hour >= 0 && hour < 7;
    }

    public async executeDailyMission(updater: ProductUpdater): Promise<void> {
        while (this.timelineQueue.length > 0) {
            if (this.isPastMidnight()) {
                for (const job of this.timelineQueue) {
                    updater.cancelPendingTask(job.task.asin, job.task.market, job.task.cycleIndex ?? 0);
                }
                this.timelineQueue = [];
                break;
            }

            const scheduledJob = this.timelineQueue.shift()!;
            
            const msUntilTarget = scheduledJob.targetTime - Date.now();
            if (msUntilTarget > 0) {
                await new Promise(resolve => setTimeout(resolve, msUntilTarget));
            }

            if (this.isPastMidnight()) {
                updater.cancelPendingTask(scheduledJob.task.asin, scheduledJob.task.market, scheduledJob.task.cycleIndex ?? 0);
                for (const job of this.timelineQueue) {
                    updater.cancelPendingTask(job.task.asin, job.task.market, job.task.cycleIndex ?? 0);
                }
                this.timelineQueue = [];
                break;
            }

            await this.enforceRateLimit();

            try {
                const config = this.adapter.buildRequestConfig(scheduledJob.task, this.apiKey);
                const response = await axios(config);
                const normalized: any = this.adapter.extractData(response.data);

                await updater.submitResult(
                    scheduledJob.task.asin, 
                    scheduledJob.task.market, 
                    {
                        success: normalized.price !== null && normalized.price !== undefined,
                        data: normalized,
                        timestamp: new Date()
                    } as any, 
                    scheduledJob.task.cycleIndex ?? 0
                );
            } catch (error: any) {
                const errDetail = error.response?.data?.error || error.response?.data || error.message;
                console.error(`[API - ${this.name}] Fallimento task ${scheduledJob.task.asin} (${scheduledJob.task.market}):`, errDetail);
                
                await updater.submitResult(
                    scheduledJob.task.asin, 
                    scheduledJob.task.market, 
                    { success: false, error: String(errDetail), timestamp: new Date() }, 
                    scheduledJob.task.cycleIndex ?? 0
                );
            }
        }
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
    private consecutiveFailures: number = 0;

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
        this.updater = new ProductUpdater(prisma);
    }

    public registerWorker(worker: BaseWorker) {
        this.workers.push(worker);
    }

    public async healthCheck(): Promise<boolean> {
        try { 
            await this.prisma.$queryRaw`SELECT 1`;
            return this.workers.length > 0;
        } catch (dbError: any) { 
            console.error("[Dispatcher] Database PostgreSQL non raggiungibile:", dbError.message);
            await notifier.sendAlert(
                "DATABASE DOWN: Connessione PostgreSQL Fallita",
                `Il Dispatcher non riesce a dialogare con il database PostgreSQL Docker.\n\n` +
                `- Errore: ${dbError.message}\n` +
                `- Verificare che il container "shopadvisor-db" sia avviato e integro.`
            );
            return false; 
        }
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
        
        console.log(`[Dispatcher] Capacità Massima calcolata: ${maxCycles} Cicli Completi.`);
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
        const now = Date.now();

        // Determina le ore 07:00 della giornata operativa odierna sul fuso italiano
        const { now: italianDate, hour: italianHour } = this.getItalianTime();
        const operationalStart = new Date(italianDate);
        if (italianHour < 7) {
            // Se eseguito prima delle 07:00, la giornata operativa di riferimento è quella di ieri
            operationalStart.setDate(operationalStart.getDate() - 1);
        }
        operationalStart.setHours(7, 0, 0, 0);

        for (const p of products) {
            let updatesToday = 0;
            const msSinceUpdate = now - p.lastUpdated.getTime();
            const hoursSinceUpdate = msSinceUpdate / (1000 * 3600);

            // Se il prodotto è marcato per recupero forzato da ieri
            if (p.mustTomorrow) {
                updatesToday = 1;
            } else {
                switch (p.priorityCode) {
                    case 1:
                        // Priorità 1: 4 volte al giorno (ogni ~6h). 
                        // Se è stato aggiornato da poco, pianifica solo gli slot residui
                        if (hoursSinceUpdate >= 18) updatesToday = 4;
                        else if (hoursSinceUpdate >= 12) updatesToday = 3;
                        else if (hoursSinceUpdate >= 6) updatesToday = 2;
                        else updatesToday = 1;
                        break;

                    case 2:
                        // Priorità 2: 2 volte al giorno (ogni ~12h)
                        if (hoursSinceUpdate >= 12) updatesToday = 2;
                        else updatesToday = 1;
                        break;

                    case 3:
                        // Priorità 3 (1 volta al giorno lavorativo):
                        // Se l'ultimo aggiornamento è precedente alle 07:00 di OGGI, va pianificato!
                        const alreadyUpdatedToday = p.lastUpdated.getTime() >= operationalStart.getTime();

                        if (!alreadyUpdatedToday) {
                            updatesToday = 1;
                        } else {
                            // Già fatto oggi: calcoliamo quanto manca alle 07:00 di domani
                            const next7AM = new Date(operationalStart);
                            next7AM.setDate(next7AM.getDate() + 1);
                            const hoursToTomorrow7AM = Math.max(0, (next7AM.getTime() - now) / (1000 * 3600)).toFixed(1);
                            console.log(`[Dispatcher] Salto ASIN ${p.asin} (Priorità 3): già aggiornato oggi alle ${p.lastUpdated.toLocaleTimeString('it-IT')}. Programmato per domani alle 07:00 (tra ${hoursToTomorrow7AM}h).`);
                        }
                        break;

                    case 4:
                        if (hoursSinceUpdate >= 48) updatesToday = 1;
                        break;

                    case 5:
                        if (hoursSinceUpdate >= 120) updatesToday = 1;
                        break;

                    case 6:
                        if (hoursSinceUpdate >= 168) updatesToday = 1;
                        break;

                    case 7:
                        if (hoursSinceUpdate >= 288) updatesToday = 1;
                        break;
                }
            }

            if (updatesToday > 0) {
                plannedUpdates.push({ product: p, updatesCount: updatesToday });
            }
        }

        if (plannedUpdates.length === 0) {
            console.log("[Dispatcher] Nessun prodotto da aggiornare nelle ore correnti. Il catalogo è già sincronizzato.");
            return [];
        }

        return await this.applyLoadShedding(plannedUpdates, maxCycles);
    }

    private async applyLoadShedding(planned: { product: DispatcherProductRecord; updatesCount: number }[], maxCycles: number): Promise<Task[]> {
        const initialRequested = planned.reduce((sum, p) => sum + p.updatesCount, 0);
        let totalCyclesRequested = initialRequested;
        let tasksToMarkMustTomorrow: string[] = [];

        console.log(`\n[Load Shedding] Inizio bilanciamento carico:`);
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
            const eligibleForBoost = planned.filter(p => p.updatesCount > 0 && p.product.priorityCode <= 2);

            for (const p of eligibleForBoost) {
                if (totalCyclesRequested >= maxCycles) break;
                if (p.updatesCount < 4) {
                    p.updatesCount++;
                    totalCyclesRequested++;
                    backfilledCycles++;
                }
            }
            if (backfilledCycles > 0) {
                console.log(`- [Fase C - Ottimizzazione] Recuperati ${backfilledCycles} slot liberi.`);
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
        const { now: italianNowDate } = this.getItalianTime();
        
        // Calcola la mezzanotte italiana usando l'oggetto Date
        const midnightItalian = new Date(italianNowDate.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
        midnightItalian.setHours(24, 0, 0, 0);

        // Estrai il timestamp numerico in ms
        const nowMs = italianNowDate.getTime();
        const totalWindowMs = Math.max(midnightItalian.getTime() - nowMs, 60000);
        const NUM_WAVES = 4;
        const waveDurationMs = totalWindowMs / NUM_WAVES;
        
        // Prepariamo i contenitori per i cicli completi in ogni ondata
        const waveBuckets: { asin: string; isMustTomorrow: boolean; cycleIndex: number }[][] = [[], [], [], []];

        let singleUpdateCounter = 0;

        for (const p of planned) {
            if (p.updatesCount <= 0) continue;

            const asin = p.product.asin;
            const isMustTomorrow = p.product.mustTomorrow;

            if (p.updatesCount === 4) {
                for (let c = 0; c < 4; c++) {
                    this.updater.registerExpectation(asin, this.MARKETS, c);
                    waveBuckets[c].push({ asin, isMustTomorrow, cycleIndex: c });
                }
            } else if (p.updatesCount === 3) {
                [0, 1, 3].forEach((w, cIdx) => {
                    this.updater.registerExpectation(asin, this.MARKETS, cIdx);
                    waveBuckets[w].push({ asin, isMustTomorrow, cycleIndex: cIdx });
                });
            } else if (p.updatesCount === 2) {
                [0, 2].forEach((w, cIdx) => {
                    this.updater.registerExpectation(asin, this.MARKETS, cIdx);
                    waveBuckets[w].push({ asin, isMustTomorrow, cycleIndex: cIdx });
                });
            } else if (p.updatesCount === 1) {
                const targetWave = singleUpdateCounter % NUM_WAVES;
                this.updater.registerExpectation(asin, this.MARKETS, 0);
                waveBuckets[targetWave].push({ asin, isMustTomorrow, cycleIndex: 0 });
                singleUpdateCounter++;
            }
        }

        // Generazione finale dei Task atomici ordinati per targetSlotTime
        const finalTasks: Task[] = [];

        for (let w = 0; w < NUM_WAVES; w++) {
            const bucket = waveBuckets[w];
            if (!bucket || bucket.length === 0) continue;

            const validItems = bucket.filter(item => item && item.asin);
            if (validItems.length === 0) continue;

            const waveStartTime = nowMs + (w * waveDurationMs);
            const stepMs = waveDurationMs / validItems.length;

            validItems.forEach((item, idx) => {
                const targetSlotTime = Math.min(
                    waveStartTime + (idx * stepMs),
                    midnightItalian.getTime() - 2000
                );

                for (const market of this.MARKETS) {
                    finalTasks.push({
                        asin: item.asin,
                        market,
                        isMustTomorrow: Boolean(item.isMustTomorrow),
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

    // Helper per determinare gli orari precisi sul fuso italiano
    private getItalianTime(): { hour: number; now: Date } {
        const now = new Date();
        const italianHourStr = new Intl.DateTimeFormat('it-IT', {
            timeZone: 'Europe/Rome',
            hour: 'numeric',
            hour12: false
        }).format(now);
        return { hour: parseInt(italianHourStr, 10), now };
    }

    public async run(): Promise<void> {
        console.log("[Dispatcher] Servizio di monitoraggio avviato in modalità continua (24/7)...");

        const loadedWorkers = await (await import("./factory/WorkerFactory")).WorkerFactory.loadAllWorkers();
        loadedWorkers.forEach(w => { if (!this.workers.some(existing => existing.name === w.name)) { this.registerWorker(w); } });

        // LOOP INFINITO PRINCIPALE DEL DISPATCHER
        while (true) {
            try {
                const { hour, now } = this.getItalianTime();

                // 1. FASCIA NOTTURNA (00:00 - 07:00)
                // Se siamo tra mezzanotte e le 7 del mattino, pausa fino alle 07:00
                if (hour >= 0 && hour < 7) {
                    const next7AM = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Rome" }));
                    next7AM.setHours(7, 0, 0, 0);

                    const sleepMs = Math.max(10000, next7AM.getTime() - now.getTime());
                    const hoursLeft = (sleepMs / (1000 * 60 * 60)).toFixed(1);

                    console.log(`\n[Dispatcher] Finestra notturna (ore ${hour}:00). Riposo fino alle 07:00 (~${hoursLeft}h)...`);
                    await new Promise(resolve => setTimeout(resolve, sleepMs));
                    console.log(`[Dispatcher] Ore 07:00 raggiunte. Inizio preparazione della giornata operativa!`);
                    continue;
                }

                // 2. VERIFICA HEALTH CHECK
                if (!(await this.healthCheck())) {
                    console.error("[Dispatcher] Health check fallito. Riprovo tra 60 secondi...");
                    await new Promise(resolve => setTimeout(resolve, 60000));
                    continue;
                }

                // 3. PIANIFICAZIONE GIORNALIERA (ore 07:00)
                console.log(`\n[Dispatcher] Pianificazione giornaliera delle scansioni (ore ${hour}:00)...`);
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
                    }
                }

                const missionPromises = [];
                for (const [worker, assignedTasks] of taskMap.entries()) {
                    if (assignedTasks.length > 0) {
                        worker.delegateAndOrganizeTasks(assignedTasks);
                        missionPromises.push(worker.executeDailyMission(this.updater));
                    }
                }

                // 4. ESECUZIONE DELLA GIORNATA
                if (missionPromises.length > 0) {
                    await Promise.all(missionPromises);
                    await this.updater.flushPartialUpdates();
                    console.log("[Dispatcher] Tutte le scansioni previste per oggi sono state completate.");
                } else {
                    console.log("[Dispatcher] Nessun task da eseguire per la giornata odierna.");
                }

                // 5. FINESTRA DI TREGUA (15 minuti dopo la mezzanotte: fino alle 00:15)
                const { now: currentTime, hour: currentH } = this.getItalianTime();
                const truceTarget = new Date(currentTime.toLocaleString("en-US", { timeZone: "Europe/Rome" }));

                if (currentH >= 7) {
                    // Siamo di giorno/sera: puntiamo alle 00:15 della notte successiva
                    truceTarget.setHours(24, 15, 0, 0);
                } else {
                    // È già passata la mezzanotte (00:00 - 00:14): puntiamo alle 00:15 attuali
                    truceTarget.setHours(0, 15, 0, 0);
                }

                const msUntilTruceEnd = truceTarget.getTime() - currentTime.getTime();
                if (msUntilTruceEnd > 0) {
                    const minutesWait = (msUntilTruceEnd / (1000 * 60)).toFixed(1);
                    console.log(`[Dispatcher] Finestra operativa conclusa. Tregua di sicurezza attiva fino alle 00:15 (~${minutesWait} min)...`);
                    await new Promise(resolve => setTimeout(resolve, msUntilTruceEnd));
                }

                console.log("[Dispatcher] Tregua completata. Il ciclo ripassa alla sospensione notturna.");
             
            } catch (err: any) {
                this.consecutiveFailures++;
                console.error(`[Dispatcher] Errore critico nel loop giornaliero (Fallimento #${this.consecutiveFailures}):`, err.message);

                if (this.consecutiveFailures >= 3) {
                    await notifier.sendAlert(
                        "DISPATCHER IN CRASH-LOOP!",
                        `Il Dispatcher principale ha subito ${this.consecutiveFailures} crash consecutivi.\n\n` +
                        `- Ultimo Errore: ${err.message}\n` +
                        `- Stack Trace:\n${err.stack?.slice(0, 1000)}`
                    );
                }

                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }
    }
}