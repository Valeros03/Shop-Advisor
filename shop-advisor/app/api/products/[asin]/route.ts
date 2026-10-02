import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

interface PriceSnapshot {
  price: number;
  shipping: number;
  timestamp: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function GET(request: Request, context: any) {
  const params = await context.params;
  const asin = params.asin;

  try {
    const product = await prisma.product.findUnique({
      where: { asin },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseHistory = (historyJson: any): PriceSnapshot[] => {
      try {
        if (!historyJson) return [];
        if (typeof historyJson === 'string') return JSON.parse(historyJson);
        return Array.isArray(historyJson) ? historyJson : [];
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        return [];
      }
    };

    const historyIT = parseHistory(product.historyIT);
    const historyFR = parseHistory(product.historyFR);
    const historyDE = parseHistory(product.historyDE);

    const computeMarketStats = (history: PriceSnapshot[], currentPrice: number | null, shippingCost: number | null) => {
      if (history.length === 0) {
          if(currentPrice === null) {
              return { min: 0, max: 0, avg: 0, current: 0, shipping: 0 };
          } else {
               return { min: currentPrice, max: currentPrice, avg: currentPrice, current: currentPrice, shipping: shippingCost ?? 0 };
          }
      }

      const prices = history.map(h => h.price);
      if(currentPrice !== null) prices.push(currentPrice); // Include current price for accurate stats

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      return { min, max, avg, current: currentPrice ?? 0, shipping: shippingCost ?? 0 };
    };

    const statsIT = computeMarketStats(historyIT, product.currentPriceIT, product.shippingIT);
    const statsFR = computeMarketStats(historyFR, product.currentPriceFR, product.shippingFR);
    const statsDE = computeMarketStats(historyDE, product.currentPriceDE, product.shippingDE);

    // Mappa la storia dei prezzi per il grafico
    const allDates = Array.from(new Set([
        ...historyIT.map(h => h.timestamp.split('T')[0]),
        ...historyFR.map(h => h.timestamp.split('T')[0]),
        ...historyDE.map(h => h.timestamp.split('T')[0])
    ])).sort();

    const chartData = allDates.map(date => {
        const getPriceForDate = (history: PriceSnapshot[]) => {
             // Get the last recorded price for this date or before
             const relevantRecords = history.filter(h => h.timestamp.split('T')[0] <= date);
             if (relevantRecords.length > 0) {
                 return relevantRecords[relevantRecords.length - 1].price;
             }
             return null;
        };

        return {
            month: new Date(date).toLocaleDateString('it-IT', { month: 'short', day: 'numeric' }), // Formato per la UI
            fullDate: date,
            IT: getPriceForDate(historyIT),
            FR: getPriceForDate(historyFR),
            DE: getPriceForDate(historyDE),
        };
    });


    // --- Logica Prezzo Consigliato ---
    const allMinPrices = [statsIT.min, statsFR.min, statsDE.min].filter(p => p > 0);
    const absoluteMin = allMinPrices.length > 0 ? Math.min(...allMinPrices) : 0;

    // Consigliamo di puntare a un prezzo leggermente sopra il minimo storico per avere una buona probabilità di match
    const recommendedPrice = absoluteMin > 0 ? absoluteMin + (absoluteMin * 0.05) : 0; // +5% dal minimo


    const responseData = {
      product: {
        id: product.id,
        asin: product.asin,
        name: product.name,
        image: product.image,
      },
      marketsStats: [
        { code: 'IT', name: 'Italia', flag: '🇮🇹', color: '#2b8a3e', url: `https://amazon.it/dp/${product.asin}`, ...statsIT },
        { code: 'FR', name: 'Francia', flag: '🇫🇷', color: '#3b82f6', url: `https://amazon.fr/dp/${product.asin}`, ...statsFR },
        { code: 'DE', name: 'Germania', flag: '🇩🇪', color: '#f59e0b', url: `https://amazon.de/dp/${product.asin}`, ...statsDE },
      ],
      chartData,
      absoluteMin,
      recommendedPrice: Number(recommendedPrice.toFixed(2))
    };

    return NextResponse.json(responseData);

  } catch (error) {
    console.error('Error fetching product details:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
