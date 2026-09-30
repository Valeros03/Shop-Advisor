import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    if (!body.telegramId) {
      return NextResponse.json({ error: 'ID mancante' }, { status: 400 });
    }

    // Interroghiamo il database usando Prisma per assicurarci che l'utente esista ancora
    const user = await prisma.user.findUnique({
      where: { 
        telegramId: BigInt(body.telegramId) 
      }
    });

    // Se l'utente è stato cancellato dal DB, blocchiamo l'accesso
    if (!user) {
      return NextResponse.json({ valid: false }, { status: 401 });
    }

    // Se l'utente esiste, confermiamo al middleware che può passare
    return NextResponse.json({ valid: true });

  } catch (error) {
    console.error("Errore verifica DB:", error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}