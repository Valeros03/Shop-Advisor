import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('shopadvisor-auth')?.value;

    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    let userId: string;
    try {
      const secret = new TextEncoder().encode(botToken);
      const { payload } = await jwtVerify(token, secret);
      userId = payload.userId as string;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { asin, targetPrice } = await request.json();

    if (!asin || targetPrice === undefined || targetPrice === null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const product = await prisma.product.findUnique({
      where: { asin },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

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

    return NextResponse.json({ success: true, alert });

  } catch (error) {
    console.error('Error saving alert:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
