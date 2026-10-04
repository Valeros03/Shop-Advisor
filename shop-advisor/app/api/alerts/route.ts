// app/api/alerts/route.ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

async function getAuthenticatedUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('shopadvisor-auth')?.value;
    if (!token) return null;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return null;

    const secret = new TextEncoder().encode(botToken);
    const { payload } = await jwtVerify(token, secret);
    return (payload.userId as string) || null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { asin, targetPrice } = await request.json();
    if (!asin || typeof targetPrice !== 'number' || targetPrice <= 0) {
      return NextResponse.json({ error: 'Dati non validi' }, { status: 400 });
    }

    const product = await prisma.product.findUnique({ where: { asin } });
    if (!product) {
      return NextResponse.json({ error: 'Prodotto non trovato' }, { status: 404 });
    }

    // Upsert: crea o aggiorna la soglia
    const alert = await prisma.alert.upsert({
      where: {
        userId_productId: {
          userId,
          productId: product.id,
        },
      },
      update: {
        targetPrice,
        isActive: true,
      },
      create: {
        userId,
        productId: product.id,
        targetPrice,
        isActive: true,
      },
    });

    return NextResponse.json({ success: true, alertId: alert.id, targetPrice: alert.targetPrice });
  } catch (error: any) {
    console.error('[API_ALERTS_POST]', error);
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const asin = searchParams.get('asin');

    if (!asin) {
      return NextResponse.json({ error: 'ASIN mancante' }, { status: 400 });
    }

    const product = await prisma.product.findUnique({ where: { asin } });
    if (!product) {
      return NextResponse.json({ error: 'Prodotto non trovato' }, { status: 404 });
    }

    await prisma.alert.deleteMany({
      where: {
        userId,
        productId: product.id,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('[API_ALERTS_DELETE]', error);
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 });
  }
}