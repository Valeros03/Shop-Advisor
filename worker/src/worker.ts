import { Task, WorkerResult, WorkerLimits, ApiAdapter, AmazonMarket, ProductRecord } from "./types";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { WorkerFactory } from "./factory/WorkerFactory";
import { ProductUpdater } from "./Updater";
import { notifier } from "./service/NotificationService";

import * as path from "path";


//__________________________________________________________
//                                                          |
//                  ***BASE WORKER***                       |
//                                                          |
//__________________________________________________________|
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
    protected static prismaClient = new PrismaClient();

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

    
    public supportsMarket(market: AmazonMarket): boolean {
        return this.supportedMarkets.includes(market);
    }

    public hasCapacity(): boolean {
        return this.getRemainingCapacity() > 0;
    }

    public getRemainingCapacity(): number {
        let remaining = Infinity;
        if (this.limits.dailyLimit !== -1) {
            remaining = Math.min(remaining, this.limits.dailyLimit - this.currentDailyUsage);
        }
        if (this.limits.monthlyLimit !== -1) {
            remaining = Math.min(remaining, this.limits.monthlyLimit - this.currentMonthlyUsage);
        }
        if (this.limits.lifetimeLimit !== -1) {
            remaining = Math.min(remaining, this.limits.lifetimeLimit - this.currentLifetimeUsage);
        }
        return Math.max(0, remaining);
    }

    public reserveCapacity(): boolean {
        if (!this.hasCapacity()) return false;

        const updateData: any = {};
        const createData: any = { name: this.name, dailyUsage: 0, monthlyUsage: 0, lifetimeUsage: 0 };

        if (this.limits.dailyLimit !== -1) {
            this.currentDailyUsage++;
            updateData.dailyUsage = { increment: 1 };
            createData.dailyUsage = this.currentDailyUsage;
        }

        if (this.limits.monthlyLimit !== -1) {
            this.currentMonthlyUsage++;
            updateData.monthlyUsage = { increment: 1 };
            createData.monthlyUsage = this.currentMonthlyUsage;
        }

        if (this.limits.lifetimeLimit !== -1) {
            this.currentLifetimeUsage++;
            updateData.lifetimeUsage = { increment: 1 };
            createData.lifetimeUsage = this.currentLifetimeUsage;
        }

        // Scrivi su DB solo se c'è almeno un contatore effettivo da tracciare
        if (Object.keys(updateData).length > 0) {
            BaseWorker.prismaClient.workerStat.upsert({
                where: { name: this.name },
                update: updateData,
                create: createData
            }).catch(err => console.error(`[WorkerStat] Errore salvataggio statistiche ${this.name}:`, err.message));
        }

        return true;
    }

    /**
     * Sincronizza lo stato ed effettua il rollover giornaliero e mensile.
     * Controlla se l'aggiornamento è già avvenuto in giornata o nel mese corrente.
     */
    public async syncRollover(): Promise<void> {
        try {
            const stat = await BaseWorker.prismaClient.workerStat.findUnique({
                where: { name: this.name }
            });

            const now = new Date();
            const nowParts = getItalianDateParts(now);

            if (!stat) {
                // Prima registrazione del record
                await BaseWorker.prismaClient.workerStat.create({
                    data: {
                        name: this.name,
                        dailyUsage: 0,
                        monthlyUsage: 0,
                        lifetimeUsage: 0,
                        lastResetDaily: now
                    }
                });
                this.currentDailyUsage = 0;
                this.currentMonthlyUsage = 0;
                return;
            }

            const lastResetParts = getItalianDateParts(stat.lastResetDaily);
            const isSameDay = lastResetParts.dateKey === nowParts.dateKey;
            const isSameMonth = lastResetParts.monthKey === nowParts.monthKey;

            const updateData: any = {};

            // 1. VERIFICA GIORNALIERA (Giorno solare di Roma)
            if (!isSameDay) {
                // Non è ancora stato aggiornato oggi: azzera dailyUsage (se ha un limite) e marca la data odierna
                if (this.limits.dailyLimit !== -1) {
                    this.currentDailyUsage = 0;
                    updateData.dailyUsage = 0;
                } else {
                    this.currentDailyUsage = 0;
                }
                updateData.lastResetDaily = now;
                console.log(`[WorkerStat - ${this.name}] Nuovo giorno (${nowParts.dateKey}): dailyUsage azzerato.`);
            } else {
                // Già aggiornato oggi: riallinea la memoria col DB per non perdere il conteggio pre-crash
                this.currentDailyUsage = this.limits.dailyLimit !== -1 ? stat.dailyUsage : 0;
                console.log(`[WorkerStat - ${this.name}] Già sincronizzato in giornata (${nowParts.dateKey}). dailyUsage mantenuto a ${this.currentDailyUsage}.`);
            }

            // 2. VERIFICA MENSILE (Mese solare di Roma)
            if (!isSameMonth) {
                // Mese differente rispetto all'ultimo reset: azzera monthlyUsage (se ha un limite)
                if (this.limits.monthlyLimit !== -1) {
                    this.currentMonthlyUsage = 0;
                    updateData.monthlyUsage = 0;
                } else {
                    this.currentMonthlyUsage = 0;
                }
                console.log(`[WorkerStat - ${this.name}] Nuovo mese (${nowParts.monthKey}): monthlyUsage azzerato.`);
            } else {
                // Mese corrente: conserva il conteggio mensile
                this.currentMonthlyUsage = this.limits.monthlyLimit !== -1 ? stat.monthlyUsage : 0;
            }

            // Allineamento lifetime
            this.currentLifetimeUsage = this.limits.lifetimeLimit !== -1 ? stat.lifetimeUsage : 0;

            if (Object.keys(updateData).length > 0) {
                await BaseWorker.prismaClient.workerStat.update({
                    where: { name: this.name },
                    data: updateData
                });
            }
        } catch (err: any) {
            console.error(`[WorkerStat - ${this.name}] Errore durante syncRollover:`, err.message);
        }
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



//__________________________________________________________
//                                                          |
//                  ***API WORKER***                        |
//                                                          |
//__________________________________________________________|

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
        
        const endOfDay = getItalianMidnightTimestamp();
        this.timelineQueue = [];

        assignedTasks.forEach((task) => {
            const baseTime = task.targetSlotTime ?? now;
            const jitter = (Math.random() * 60000) - 30000;
            const targetTime = Math.min(Math.max(baseTime + jitter, now), endOfDay - 1000);
            this.timelineQueue.push({ targetTime, task });
        });

        this.timelineQueue.sort((a, b) => a.targetTime - b.targetTime);
    }

    public async executeDailyMission(updater: ProductUpdater): Promise<void> {
        while (this.timelineQueue.length > 0) {
            if (isPastWorkerShift()) {
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

            if (isPastWorkerShift()) {
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






//__________________________________________________________
//                                                          |
//                  ***SMART DISPATCHER***                  |
//                                                          |
//__________________________________________________________|
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

        // 07:00 della giornata operativa corrente
        const operationalStart = getItalianOperationalStart(new Date(now));

        for (const p of products) {
            let updatesToday = 0;
            
            // Protezione se il prodotto è nuovo e non è mai stato aggiornato (lastUpdated = null)
            const lastUpdatedMs = p.lastUpdated ? p.lastUpdated.getTime() : 0;
            const msSinceUpdate = now - lastUpdatedMs;
            const hoursSinceUpdate = msSinceUpdate / (1000 * 3600);

            if (p.mustTomorrow) {
                updatesToday = 1;
            } else {
                switch (p.priorityCode) {
                    case 1:
                        if (hoursSinceUpdate >= 18) updatesToday = 4;
                        else if (hoursSinceUpdate >= 12) updatesToday = 3;
                        else if (hoursSinceUpdate >= 6) updatesToday = 2;
                        else updatesToday = 1;
                        break;

                    case 2:
                        if (hoursSinceUpdate >= 12) updatesToday = 2;
                        else updatesToday = 1;
                        break;

                    case 3:
                        // Se p.lastUpdated è null o precedente alle 07:00 di OGGI, va pianificato
                        const alreadyUpdatedToday = lastUpdatedMs >= operationalStart.getTime();

                        if (!alreadyUpdatedToday) {
                            updatesToday = 1;
                        } else {
                            const next7AM = new Date(operationalStart);
                            next7AM.setDate(next7AM.getDate() + 1);
                            const hoursToTomorrow7AM = Math.max(0, (next7AM.getTime() - now) / (1000 * 3600)).toFixed(1);
                            console.log(`[Dispatcher] Salto ASIN ${p.asin} (Priorità 3): già aggiornato oggi alle ${p.lastUpdated!.toLocaleTimeString('it-IT')}. Prossimo slot: domani alle 07:00 (tra ${hoursToTomorrow7AM}h).`);
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
        const nowMs = Date.now();
        const midnightItalianMs = getItalianMidnightTimestamp();
        const totalWindowMs = Math.max(midnightItalianMs - nowMs, 60000);
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
                    midnightItalianMs - 2000
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


    public async run(): Promise<void> {
        console.log("[Dispatcher] Servizio avviato (Turno di lavoro: 07:00 - 00:00 | Tregua: fino alle 00:15 Europe/Rome)...");

        const loadedWorkers = await (await import("./factory/WorkerFactory")).WorkerFactory.loadAllWorkers();
        loadedWorkers.forEach(w => { if (!this.workers.some(existing => existing.name === w.name)) { this.registerWorker(w); } });

        while (true) {
            try {
                // 1. BLOCCO NOTTURNO DI SICUREZZA (00:00 - 07:00)
                // Se il bot viene avviato o si trova di notte, riposa fino alle 07:00
                if (isPastWorkerShift()) {
                    const sleepMs = getMsUntilItalianTarget(7, 0);
                    const hoursLeft = (sleepMs / (1000 * 60 * 60)).toFixed(1);
                    console.log(`\n[Dispatcher] Riposo notturno attivo. Standby fino alle 07:00 (~${hoursLeft}h)...`);
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
                console.log(`\n[Dispatcher] Inizio pianificazione delle scansioni odierne...`);
                
                for (const worker of this.workers) {
                    await worker.syncRollover();
                }
                
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

                // 4. ESECUZIONE DELLA GIORNATA (07:00 - 00:00)
                    if (missionPromises.length > 0) {
                        // Deadline invalicabile: alle 00:15 i worker devono comunque cedere il passo
                        const msUntilTruceHardDeadline = getMsUntilItalianTarget(0, 15);
                        const truceTimeout = new Promise(resolve => setTimeout(resolve, msUntilTruceHardDeadline));

                        // Attende la conclusione naturale (o lo stop di mezzanotte) dei worker, ma non oltre le 00:15
                        await Promise.race([
                            Promise.all(missionPromises),
                            truceTimeout
                        ]);
                        console.log("[Dispatcher] Scansioni terminate o finestra di tregua (00:15) conclusa.");
                    } else {
                        console.log("[Dispatcher] Nessun task da eseguire per oggi.");
                    }

                    // Se i worker hanno terminato molto prima di mezzanotte, attendi le 00:00
                    const msUntilMidnight = getItalianMidnightTimestamp() - Date.now();
                    if (msUntilMidnight > 0) {
                        const waitMin = (msUntilMidnight / 60000).toFixed(1);
                        console.log(`[Dispatcher] Scansioni completate in anticipo. Attesa fino a mezzanotte (~${waitMin} min)...`);
                        await new Promise(resolve => setTimeout(resolve, msUntilMidnight));
                    }

                    // 5. CONSOLIDAMENTO FINALE DEI TASK RIMASTI PARZIALI
                    // Eseguito ORA, dopo che i task in volo hanno avuto il tempo di scrivere nel DB
                    console.log("[Dispatcher] Chiusura definitiva del turno: consolidamento aggiornamenti parziali...");
                    await this.updater.flushPartialUpdates();

                    // 6. RIPOSO NOTTURNO DIRETTO (fino alle 07:00)
                    const msUntil7AM = getMsUntilItalianTarget(7, 0);
                    const hoursToMorning = (msUntil7AM / (1000 * 60 * 60)).toFixed(1);
                    console.log(`[Dispatcher] Giornata conclusa. Standby notturno fino alle 07:00 (~${hoursToMorning}h)...`);
                    await new Promise(resolve => setTimeout(resolve, msUntil7AM));

                } catch (err: any) {
                    this.consecutiveFailures++;
                    console.error(`[Dispatcher] Errore critico nel loop giornaliero (Fallimento #${this.consecutiveFailures}):`, err.message);

                    if (this.consecutiveFailures >= 3) {
                        await notifier.sendAlert(
                            "DISPATCHER IN CRASH-LOOP!",
                            `Il Dispatcher principale ha subito ${this.consecutiveFailures} crash consecutivi.\n\n- Errore: ${err.message}`
                        );
                    }

                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
        }
    }
}


export function getItalianTime(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);

    const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value, 10);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
        second: get('second')
    };
}

/** Verifica se i worker devono fermarsi (00:00 - 07:00) */
export function isPastWorkerShift(): boolean {
    const { hour } = getItalianTime();
    return hour >= 0 && hour < 7;
}

/** Verifica se il Dispatcher deve dormire (00:15 - 07:00) */
export function isDispatcherSleepWindow(): boolean {
    const { hour, minute } = getItalianTime();
    if (hour === 0) return minute >= 15;
    return hour < 7;
}

/** Calcola il timestamp delle 23:59:59.999 odierne (ora di Roma) */
export function getItalianMidnightTimestamp(): number {
    const now = new Date();
    const romeDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(now);
    const isDST = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'short' })
        .formatToParts(now).find(p => p.type === 'timeZoneName')?.value === 'GMT+2';
    const offset = isDST ? '+02:00' : '+01:00';
    return new Date(`${romeDateStr}T23:59:59.999${offset}`).getTime();
}

/** Millisecondi mancanti a un determinato orario target di Roma (es. 00:15 o 07:00) */
export function getMsUntilItalianTarget(targetHour: number, targetMinute: number): number {
    const now = new Date();
    const parts = getItalianTime(now);
    const isDST = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'short' })
        .formatToParts(now).find(p => p.type === 'timeZoneName')?.value === 'GMT+2';
    const offset = isDST ? '+02:00' : '+01:00';
    const pad = (n: number) => String(n).padStart(2, '0');

    let targetDate = new Date(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(targetHour)}:${pad(targetMinute)}:00${offset}`);
    
    // Se l'orario di oggi è già trascorso, punta a quello del giorno successivo
    if (now.getTime() >= targetDate.getTime()) {
        const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
        const tomParts = getItalianTime(tomorrow);
        targetDate = new Date(`${tomParts.year}-${pad(tomParts.month)}-${pad(tomParts.day)}T${pad(targetHour)}:${pad(targetMinute)}:00${offset}`);
    }

    return Math.max(1000, targetDate.getTime() - now.getTime());
}


export function getItalianOperationalStart(now = new Date()): Date {
    const parts = getItalianTime(now);
    const isDST = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'short' })
        .formatToParts(now).find(p => p.type === 'timeZoneName')?.value === 'GMT+2';
    const offset = isDST ? '+02:00' : '+01:00';
    const pad = (n: number) => String(n).padStart(2, '0');

    const today7AM = new Date(`${parts.year}-${pad(parts.month)}-${pad(parts.day)}T07:00:00${offset}`);

    // Se per qualsiasi motivo viene chiamata tra le 00:00 e le 06:59, 
    // l'inizio del turno operativo di riferimento è quello di ieri alle 07:00
    if (parts.hour < 7) {
        return new Date(today7AM.getTime() - 24 * 3600 * 1000);
    }
    return today7AM;
}


export function getItalianDateParts(d: Date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);

    const year = parts.find(p => p.type === 'year')!.value;
    const month = parts.find(p => p.type === 'month')!.value;
    const day = parts.find(p => p.type === 'day')!.value;

    return {
        dateKey: `${year}-${month}-${day}`, // es. "2026-10-06"
        monthKey: `${year}-${month}`        // es. "2026-10"
    };
}