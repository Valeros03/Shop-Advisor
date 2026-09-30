import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { SignJWT } from 'jose';
import { cookies } from 'next/headers';
import { PrismaClient } from '@prisma/client';

// Evitiamo di istanziare multipli client Prisma in sviluppo
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function POST(request: Request) {
  try {
    const data = await request.json();
    
    // --- INIZIO DEBUG ---
    console.log("\n--- INIZIO TENTATIVO LOGIN TELEGRAM ---");
    console.log("Dati ricevuti dal frontend:", data);

    const { hash, ...userData } = data;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) {
      console.error("ERRORE CRITICO: TELEGRAM_BOT_TOKEN non è caricato!");
      return NextResponse.json({ error: 'Configurazione server errata' }, { status: 500 });
    }
    // --- FINE DEBUG ---

    // 1. Validazione crittografica di Telegram
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const checkString = Object.keys(userData)
      .sort()
      .filter((k) => userData[k] !== undefined && userData[k] !== null) 
      .map((k) => `${k}=${userData[k]}`)
      .join('\n');
    
    const hmac = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

    if (hmac !== hash) {
      console.error("HASH MISMATCH! L'autenticazione è bloccata.");
      return NextResponse.json({ error: 'Autenticazione non valida' }, { status: 401 });
    }

    console.log("HASH CORRETTO! Autenticazione Telegram riuscita. Salvo su Prisma...");

    // 2. Salvataggio / Aggiornamento utente nel Database (USANDO BIGINT)
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(userData.id) }, // Convertito in BigInt per Prisma
      update: {
        username: userData.username || null,
      },
      create: {
        telegramId: BigInt(userData.id), // Convertito in BigInt per Prisma
        username: userData.username || null,
      },
    });

    // 3. Creazione del JWT (Valido per 1 anno)
    const secret = new TextEncoder().encode(botToken);
    const token = await new SignJWT({ 
      userId: user.id, 
      telegramId: user.telegramId.toString() // Riconvertito in stringa: i JWT non supportano i BigInt nativi
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1y')
      .sign(secret);

    // 4. Impostazione del Cookie sicuro HTTP-Only
    (await cookies()).set('shopadvisor-auth', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365, // 1 anno
      path: '/',
    });

    console.log("Accesso completato e cookie impostato per l'utente:", user.telegramId);
    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error('Errore Interno Login:', error);
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
  }
}