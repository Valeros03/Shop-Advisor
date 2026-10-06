// worker/src/test/DB_printer/print-alerts.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    const alerts = await prisma.alert.findMany({
        include: {
            user: { select: { id: true, telegramId: true } },
            product: { select: { asin: true, name: true, currentPriceIT: true } }
        }
    });

    if (alerts.length === 0) {
        console.log("Nessun alert trovato nella tabella.");
        return;
    }

    console.log(`\n--- Trovati ${alerts.length} alert ---`);
    console.dir(alerts, { depth: null, colors: true });
}

main()
    .catch(console.error)
    .finally(async () => {
        await prisma.$disconnect();
    });