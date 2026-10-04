import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { BaseWorker, ApiWorker } from '../worker';
import { CustomScraperWorker } from '../scraper/scraper';
import { AdapterRegistry } from '../api/AdapterRegistry';

const prisma = new PrismaClient();

export class WorkerFactory {
    
    private static async getUsageFromDB(workerName: string) {
        try {
            const now = new Date();
            
            // Calcolo inizio giornata operativa odierna (ore 07:00)
            const currentOperationalStart = new Date(now);
            if (now.getHours() < 7) {
                currentOperationalStart.setDate(currentOperationalStart.getDate() - 1);
            }
            currentOperationalStart.setHours(7, 0, 0, 0);

            let stat = await prisma.workerStat.findUnique({
                where: { name: workerName }
            });

            // Se non esiste ancora sul DB, parte pulito da 0 per tutti i worker
            if (!stat) {
                stat = await prisma.workerStat.create({
                    data: {
                        name: workerName,
                        dailyUsage: 0,
                        monthlyUsage: 0,
                        lifetimeUsage: 0,
                        lastResetDaily: now
                    }
                });
                return {
                    daily: stat.dailyUsage,
                    monthly: stat.monthlyUsage,
                    lifetime: stat.lifetimeUsage
                };
            }

            // Controllo reset giornaliero (ore 07:00)
            const shouldResetDaily = stat.lastResetDaily.getTime() < currentOperationalStart.getTime();

            // Controllo reset mensile (cambio mese di calendario)
            const shouldResetMonthly = now.getMonth() !== stat.lastResetDaily.getMonth() || 
                                       now.getFullYear() !== stat.lastResetDaily.getFullYear();

            if (shouldResetDaily || shouldResetMonthly) {
                const newDaily = shouldResetDaily ? 0 : stat.dailyUsage;
                const newMonthly = shouldResetMonthly ? 0 : stat.monthlyUsage;

                stat = await prisma.workerStat.update({
                    where: { name: workerName },
                    data: {
                        dailyUsage: newDaily,
                        monthlyUsage: newMonthly,
                        lastResetDaily: now
                    }
                });
            }

            return {
                daily: stat.dailyUsage,
                monthly: stat.monthlyUsage,
                lifetime: stat.lifetimeUsage
            };
        } catch (error: any) {
            console.error(`[Factory] Errore lettura statistiche per ${workerName}:`, error.message);
            return { daily: 0, monthly: 0, lifetime: 0 };
        }
    }

    public static async loadAllWorkers(): Promise<BaseWorker[]> {
        const workers: BaseWorker[] = [];

        // 1. CARICA I WORKER API
        const apiConfigDir = path.resolve(__dirname, '../../config/api');
        if (fs.existsSync(apiConfigDir)) {
            const apiFiles = fs.readdirSync(apiConfigDir).filter(f => f.endsWith('.json'));
            
            for (const file of apiFiles) {
                const configPath = path.join(apiConfigDir, file);
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

                const apiKey = config.api_key || (config.env_key ? process.env[config.env_key] : undefined);
                if (!apiKey || apiKey === "LA_TUA_CHIAVE_QUI") {
                    console.warn(`[Factory] Salto ${config.name}: Chiave API non valida o placeholder presente.`);
                    continue;
                }

                const AdapterClass = AdapterRegistry[config.adapter];
                if (!AdapterClass) {
                    console.error(`[Factory] Adapter "${config.adapter}" non trovato nel registro per ${config.name}!`);
                    continue;
                }

                const initialUsage = await this.getUsageFromDB(config.name);

                const worker = new ApiWorker(
                    config.name,
                    apiKey,
                    new AdapterClass(),
                    config.limits,
                    config.supported_markets,
                    initialUsage
                );
                
                workers.push(worker);
                console.log(`[Factory] Caricato API Worker: ${config.name} (Uso: D:${initialUsage.daily}, M:${initialUsage.monthly}, L:${initialUsage.lifetime})`);
            }
        }

        // 2. CARICA I WORKER SCRAPER
        const scraperConfigDir = path.resolve(__dirname, '../../config/scraper');
        if (fs.existsSync(scraperConfigDir)) {
            const scraperFiles = fs.readdirSync(scraperConfigDir).filter(f => f.endsWith('.json'));
            
            for (const file of scraperFiles) {
                const configPath = path.join(scraperConfigDir, file);
                const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

                const initialUsage = await this.getUsageFromDB(config.name);

                const worker = new CustomScraperWorker(
                    config.name,
                    config.limits,
                    config.supported_markets,
                    initialUsage
                );

                workers.push(worker);
                console.log(`[Factory] Caricato Scraper Worker: ${config.name} (Uso: D:${initialUsage.daily}, M:${initialUsage.monthly}, L:${initialUsage.lifetime})`);
            }
        }

        return workers;
    }
}