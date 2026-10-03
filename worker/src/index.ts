// index.ts
import { PrismaClient } from "@prisma/client";
import { SmartDispatcher } from "./worker";
import * as path from "path";
const { PrismaClient } = require(path.resolve(__dirname, "../../shop-advisor/node_modules/@prisma/client"));

const prisma = new PrismaClient();
const dispatcher = new SmartDispatcher(prisma);

async function bootstrap() {
    console.log("=== AVVIO SISTEMA MONITORAGGIO PREZZI ===");

    // Gestione Graceful Shutdown
    const handleShutdown = async (signal: string) => {
        console.log(`\n[System] Ricevuto segnale ${signal}. Chiusura pulita in corso...`);
        try {
            // Salva forzatamente gli aggiornamenti parziali ancora in RAM prima di spegnersi
            await (dispatcher as any).updater?.flushPartialUpdates();
            await prisma.$disconnect();
            console.log("[System] Disconnessione database completata. Uscita.");
        } catch (err) {
            console.error("[System] Errore durante la chiusura:", err);
        } finally {
            process.exit(0);
        }
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));

    try {
        await dispatcher.run();
    } catch (err) {
        console.error("[Fatal Error] Errore non gestito nel ciclo del Dispatcher:", err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

bootstrap();