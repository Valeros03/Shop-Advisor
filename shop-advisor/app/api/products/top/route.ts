import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function GET() {
  try {
    const products = await prisma.product.findMany({
      include: {
        _count: {
          select: { alerts: { where: { isActive: true } } },
        },
      },
      orderBy: {
        alerts: {
          _count: 'desc',
        },
      },
      take: 6,
    });

    const formattedProducts = products.map((product) => {
      let bestPrice = null;
      let market = null;
      let url = null;

      const prices = [
        { market: 'IT', price: product.currentPriceIT, url: `https://amazon.it/dp/${product.asin}` },
        { market: 'FR', price: product.currentPriceFR, url: `https://amazon.fr/dp/${product.asin}` },
        { market: 'DE', price: product.currentPriceDE, url: `https://amazon.de/dp/${product.asin}` },
      ];

      for (const p of prices) {
        if (p.price && (!bestPrice || p.price < bestPrice)) {
          bestPrice = p.price;
          market = p.market;
          url = p.url;
        }
      }

      return {
        id: product.id,
        name: product.name,
        asin: product.asin,
        saves: product._count.alerts,
        price: bestPrice ? `${bestPrice.toFixed(2)}€` : 'N/A',
        image: product.image,
        market: market,
        amazonUrl: url,
      };
    });

    return NextResponse.json(formattedProducts);
  } catch (error) {
    console.error('Error fetching top products:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
