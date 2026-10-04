import * as dotenv from "dotenv";
import * as path from "path";

// 1. Carica il file .env di shop-advisor con il DATABASE_URL di PostgreSQL
const envPath = path.resolve(__dirname, "../../shop-advisor/.env");
dotenv.config({ path: envPath });

import { gotScraping } from "got-scraping";
import * as cheerio from "cheerio";
import * as fs from "fs";
import { WorkerFactory } from "../src/factory/WorkerFactory";
import { AmazonMarket } from "../src/types";

const prisma = new PrismaClient();
const POOL_PATH = path.join(process.cwd(), "data", "asin_pool.json");

interface DiscoveredProduct {
    asin: string;
    name: string;
    image: string;
}

// 1. Ispezione capacità reali
async function printCurrentCapacities() {
    console.log("\n--- VERIFICA CAPACITÀ WORKER CONFIGURATI ---");
    const workers = await WorkerFactory.loadAllWorkers();
    
    if (workers.length === 0) {
        console.warn("[Bootstrap] ⚠️ Nessun worker attivo trovato nei file di configurazione!");
        return;
    }

    for (const w of workers) {
        console.log(`• [${w.type.toUpperCase()}] ${w.name}:`);
        console.log(`   - Mercati: [${w.supportedMarkets.join(", ")}]`);
        console.log(`   - Capacità Residua Oggi: ${w.getRemainingCapacity()} task`);
    }
}

// 2. Ricerca su Amazon con estrazione di ASIN, Titolo e Immagine
async function searchAmazonForProducts(
    query: string, 
    market: AmazonMarket = "amazon.it", 
    maxResults: number = 25
): Promise<DiscoveredProduct[]> {
    console.log(`\n[Bootstrap] 🔍 Ricerca su ${market} per: "${query}"...`);
    const searchUrl = `https://www.${market}/s?k=${encodeURIComponent(query)}`;

    try {
        const response = await gotScraping({
            url: searchUrl,
            headers: {
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
                "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
                "cache-control": "no-cache",
                "pragma": "no-cache",
                "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
            }
        });

        const html = response.body;
        const $ = cheerio.load(html);

        // Controllo Anti-Bot / CAPTCHA immediato
        if (html.includes("Inserisci i caratteri visualizzati qui sopra") || html.includes("api-services-support@amazon.com") || $('form[action*="validateCaptcha"]').length > 0) {
            console.warn(`[Bootstrap] ⚠️ Amazon ha risposto con una richiesta di CAPTCHA. Riprova tra pochi istanti.`);
            return [];
        }

        const discovered = new Map<string, DiscoveredProduct>();

        // Selettore mirato sui singoli box prodotto reali della griglia
        $('div[data-component-type="s-search-result"], div[data-asin]').each((_, el) => {
            const asin = $(el).attr("data-asin")?.trim();
            if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return;
            if (discovered.has(asin)) return;

            // 1. Estrazione Titolo (dall'aria-label, dall'h2 span o dall'alt dell'immagine)
            const h2 = $(el).find("h2");
            let title = h2.attr("aria-label")?.trim() || "";
            if (!title) title = h2.find("span").text().trim();
            if (!title) title = h2.text().trim();
            if (!title) title = $(el).find("img.s-image").attr("alt")?.trim() || "";

            title = title.replace(/\s+/g, " ").trim();

            // 2. Estrazione Immagine (gestisce src, data-src e srcset con regex)
            const imgEl = $(el).find("img.s-image, img[data-image-latency='s-product-image']");
            let image = imgEl.attr("src")?.trim() || imgEl.attr("data-src")?.trim() || "";

            if (!image || image.includes("base64")) {
                const srcset = imgEl.attr("srcset");
                if (srcset) {
                    const firstUrlMatch = srcset.split(",")[0].trim().split(" ")[0];
                    if (firstUrlMatch) image = firstUrlMatch;
                }
            }

            if (!image) {
                image = "https://m.media-amazon.com/images/I/default.jpg";
            }

            if (title && title.length > 5) {
                discovered.set(asin, { asin, name: title, image });
            }
        });

        const results = Array.from(discovered.values()).slice(0, maxResults);
        console.log(`[Bootstrap] ✅ Estratti ${results.length} prodotti con titolo reale e immagine.`);
        return results;
    } catch (err: any) {
        console.error(`[Bootstrap] ❌ Errore ricerca Amazon:`, err.message);
        return [];
    }
}

// 3. Gestione file di staging asin_pool.json
function loadPool(): DiscoveredProduct[] {
    if (!fs.existsSync(POOL_PATH)) {
        fs.mkdirSync(path.dirname(POOL_PATH), { recursive: true });
        fs.writeFileSync(POOL_PATH, JSON.stringify([]), "utf-8");
        return [];
    }
    try {
        const raw = fs.readFileSync(POOL_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        // Compatibilità nel caso ci fossero vecchie stringhe ASIN semplici
        return parsed.map((item: any) => {
            if (typeof item === "string") {
                return { asin: item, name: `Prodotto ${item}`, image: "https://m.media-amazon.com/images/I/default.jpg" };
            }
            return item;
        });
    } catch {
        return [];
    }
}

function savePool(pool: DiscoveredProduct[]): void {
    fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2), "utf-8");
}

// 4. Esecuzione del Bootstrap
async function runBootstrap(batchSize: number = 10, searchQuery: string = "RAM 32GB DDR5") {
    console.log("=== AVVIO PROCEDURA DI BOOTSTRAP PRODOTTI ===");

    await printCurrentCapacities();

    let pool = loadPool();
    console.log(`\n[Bootstrap] Prodotti attualmente in staging (${POOL_PATH}): ${pool.length}`);

    // Se il pool locale non basta, fa scraping dei prodotti completi
    if (pool.length < batchSize) {
        console.log(`[Bootstrap] Staging sotto soglia (< ${batchSize}). Ricerca di nuovi prodotti...`);
        const freshProducts = await searchAmazonForProducts(searchQuery, "amazon.it", 25);
        
        // Evita duplicati per ASIN nel pool
        const poolMap = new Map(pool.map(p => [p.asin, p]));
        for (const item of freshProducts) {
            if (!poolMap.has(item.asin)) {
                poolMap.set(item.asin, item);
            }
        }
        pool = Array.from(poolMap.values());
        savePool(pool);
        console.log(`[Bootstrap] Staging pool aggiornato a ${pool.length} prodotti.`);
    }

    if (pool.length === 0) {
        console.warn("[Bootstrap] Nessun prodotto disponibile.");
        await prisma.$disconnect();
        return;
    }

    // Controllo duplicati su PostgreSQL
    const existingProducts = await prisma.product.findMany({
        where: { asin: { in: pool.map(p => p.asin) } },
        select: { asin: true }
    });
    const existingSet = new Set(existingProducts.map((p: any) => p.asin));

    const eligible = pool.filter(p => !existingSet.has(p.asin));
    const duplicatesCount = pool.length - eligible.length;

    if (duplicatesCount > 0) {
        console.log(`[Bootstrap] ℹ️ Ignorati ${duplicatesCount} prodotti già presenti a database.`);
    }

    // Preleva il batch desiderato
    const toImport = eligible.slice(0, batchSize);
    console.log(`\n[Bootstrap] 📥 Inserimento di ${toImport.length} nuovi prodotti nel database...`);

    const insertedAsins: string[] = [];

    for (const item of toImport) {
        try {
            await prisma.product.create({
                data: {
                    asin: item.asin,
                    name: item.name,        // Titolo reale estratto dalla pagina!
                    image: item.image,      // Foto reale del prodotto!
                    priorityCode: 3,        // 1 aggiornamento al giorno
                    mustTomorrow: false,
                    unchangedCount: 0,
                    lastUpdated: new Date(0) // Massima urgenza per il primo avvio del Dispatcher
                }
            });
            insertedAsins.push(item.asin);
            console.log(`  ✓ Inserito [${item.asin}]: ${item.name.slice(0, 60)}...`);
        } catch (err: any) {
            console.error(`  ✗ Errore inserimento ${item.asin}:`, err.message);
        }
    }

    // Rimuove dallo staging sia quelli appena inseriti sia quelli già a DB
    const processedSet = new Set([...insertedAsins, ...existingSet]);
    const updatedPool = pool.filter(p => !processedSet.has(p.asin));
    savePool(updatedPool);

    console.log(`\n[Bootstrap] 🧹 Staging pool aggiornato. Prodotti rimasti nel file: ${updatedPool.length}`);
    console.log(`[Bootstrap] 🚀 ${insertedAsins.length} prodotti completi inseriti con successo!`);

    await prisma.$disconnect();
}

// Esegui il bootstrap
runBootstrap(10, "RAM 32GB DDR5").catch(console.error);