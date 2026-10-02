import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    if (!q) {
      return NextResponse.json({ error: 'Missing query parameter q' }, { status: 400 });
    }

    const products = await prisma.product.findMany({
      where: {
        OR: [
          { asin: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: 20,
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
        price: bestPrice ? `${bestPrice.toFixed(2)}€` : 'N/A',
        image: product.image,
        market: market,
        amazonUrl: url,
      };
    });

    return NextResponse.json(formattedProducts);
  } catch (error) {
    console.error('Error searching products:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
