import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { BaseWorker, ApiWorker } from '../worker';
import { CustomScraperWorker } from '../scraper/scraper';
import { AdapterRegistry } from '../api/AdapterRegistry';

const prisma = new PrismaClient();

export class WorkerFactory {
    
    // Legge l'utilizzo reale persistito nel database
    private static async getUsageFromDB(workerName: string) {
        try {
            const stat = await prisma.workerStat.findUnique({
                where: { name: workerName }
            });
            if (!stat) return { daily: 0, monthly: 0, lifetime: 0 };
            return {
                daily: stat.dailyUsage,
                monthly: stat.monthlyUsage,
                lifetime: stat.lifetimeUsage
            };
        } catch {
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

                // Legge la chiave: prima da api_key diretta, poi da process.env[env_key]
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
                console.log(`[Factory] Caricato API Worker: ${config.name}`);
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
                console.log(`[Factory] Caricato Scraper Worker: ${config.name}`);
            }
        }

        return workers;
    }
}