import { PrismaClient } from "@prisma/client";
import { SmartDispatcher } from "./worker";

const prisma = new PrismaClient();

async function bootstrap() {
  const dispatcher = new SmartDispatcher(prisma);

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