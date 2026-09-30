import * as fs from 'fs';
import * as path from 'path';
import { BaseWorker, ApiWorker } from '../worker';
import { CustomScraperWorker } from '../scraper/scraper';
import { AdapterRegistry } from '../api/AdapterRegistry';

export class WorkerFactory {
    
    // Funzione simulata che andrà a leggere dal DB gli utilizzi attuali dei worker
    private static async getUsageFromDB(workerName: string) {
        // Simulazione: ritorna sempre 0. 
        // Nella realtà: await prisma.workerStat.findUnique({ where: { name: workerName } })
        return { daily: 0, monthly: 0, lifetime: 0 };
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

                // Ottiene la chiave API dall'ambiente (es. process.env.SERPAPI_KEY)
                const apiKey = process.env[config.env_key];
                if (!apiKey) {
                    console.warn(`[Factory] Salto ${config.name}: Chiave API ${config.env_key} non trovata nell'ambiente.`);
                    continue;
                }

                // Trova l'adapter corretto dal registro
                const AdapterClass = AdapterRegistry[config.adapter];
                if (!AdapterClass) {
                    console.error(`[Factory] Adapter ${config.adapter} non trovato nel registro!`);
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