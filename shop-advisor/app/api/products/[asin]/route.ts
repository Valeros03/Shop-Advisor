import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

interface PriceSnapshot {
  price: number;
  shipping: number;
  timestamp: string;
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function GET(request: Request, context: any) {
  const params = await context.params;
  const asin = params.asin;

  try {
    const userId = await getAuthenticatedUserId();

    const product = await prisma.product.findUnique({
      where: { asin },
      include: {
        alerts: userId
          ? {
              where: { userId: userId, isActive: true },
            }
          : false,
      },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    const userAlert = product.alerts && product.alerts.length > 0 ? product.alerts[0] : null;

    const parseHistory = (historyJson: any): PriceSnapshot[] => {
      try {
        if (!historyJson) return [];
        if (typeof historyJson === 'string') return JSON.parse(historyJson);
        return Array.isArray(historyJson) ? historyJson : [];
      } catch {
        return [];
      }
    };

    const historyIT = parseHistory(product.historyIT);
    const historyFR = parseHistory(product.historyFR);
    const historyDE = parseHistory(product.historyDE);

    const computeMarketStats = (history: PriceSnapshot[], currentPrice: number | null, shippingCost: number | null) => {
      if (history.length === 0) {
        if (currentPrice === null) {
          return { min: 0, max: 0, avg: 0, current: 0, shipping: 0 };
        } else {
          return { min: currentPrice, max: currentPrice, avg: currentPrice, current: currentPrice, shipping: shippingCost ?? 0 };
        }
      }

      const prices = history.map(h => h.price);
      if (currentPrice !== null && currentPrice > 0) prices.push(currentPrice);

      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      return { min, max, avg, current: currentPrice ?? 0, shipping: shippingCost ?? 0 };
    };

    const statsIT = computeMarketStats(historyIT, product.currentPriceIT, product.shippingIT);
    const statsFR = computeMarketStats(historyFR, product.currentPriceFR, product.shippingFR);
    const statsDE = computeMarketStats(historyDE, product.currentPriceDE, product.shippingDE);

    const allDates = Array.from(new Set([
      ...historyIT.map(h => h.timestamp.split('T')[0]),
      ...historyFR.map(h => h.timestamp.split('T')[0]),
      ...historyDE.map(h => h.timestamp.split('T')[0]),
    ])).sort();

    const historyDaysCount = allDates.length;
    const hasLongHistory = historyDaysCount >= 14;

    const getPriceForDate = (history: PriceSnapshot[], date: string) => {
      const relevantRecords = history.filter(h => h.timestamp.split('T')[0] <= date);
      return relevantRecords.length > 0 ? relevantRecords[relevantRecords.length - 1].price : null;
    };

    let chartData: any[] = [];
    if (allDates.length === 1) {
      const singleDate = allDates[0];
      const dateLabel = new Date(singleDate).toLocaleDateString('it-IT', { month: 'short', day: 'numeric' });
      chartData = [
        {
          month: `${dateLabel} (Rilevazione)`,
          fullDate: singleDate,
          IT: getPriceForDate(historyIT, singleDate) ?? product.currentPriceIT,
          FR: getPriceForDate(historyFR, singleDate) ?? product.currentPriceFR,
          DE: getPriceForDate(historyDE, singleDate) ?? product.currentPriceDE,
        },
        {
          month: 'Attuale',
          fullDate: singleDate,
          IT: product.currentPriceIT ?? getPriceForDate(historyIT, singleDate),
          FR: product.currentPriceFR ?? getPriceForDate(historyFR, singleDate),
          DE: product.currentPriceDE ?? getPriceForDate(historyDE, singleDate),
        },
      ];
    } else {
      chartData = allDates.map(date => ({
        month: new Date(date).toLocaleDateString('it-IT', { month: 'short', day: 'numeric' }),
        fullDate: date,
        IT: getPriceForDate(historyIT, date),
        FR: getPriceForDate(historyFR, date),
        DE: getPriceForDate(historyDE, date),
      }));
    }

    const allMinPrices = [statsIT.min, statsFR.min, statsDE.min].filter(p => p > 0);
    const absoluteMin = allMinPrices.length > 0 ? Math.min(...allMinPrices) : 0;

    const currentValidPrices = [product.currentPriceIT, product.currentPriceFR, product.currentPriceDE]
      .filter((p): p is number => typeof p === 'number' && p > 0);
    const lowestCurrent = currentValidPrices.length > 0 ? Math.min(...currentValidPrices) : absoluteMin;

    let smartTargetPrice = 0;
    if (lowestCurrent > 0) {
      if (absoluteMin > 0 && absoluteMin < lowestCurrent) {
        smartTargetPrice = absoluteMin;
      } else {
        const discounted = lowestCurrent * 0.95;
        smartTargetPrice = Math.floor(discounted) + 0.99;
        if (smartTargetPrice >= lowestCurrent) {
          smartTargetPrice = Math.max(1, lowestCurrent - 1);
        }
      }
    }

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
      historyDaysCount,
      hasLongHistory,
      recommendedPrice: Number(smartTargetPrice.toFixed(2)),
      // Stato di tracciamento dell'utente
      isUserTracking: !!userAlert,
      currentAlertPrice: userAlert ? userAlert.targetPrice : null,
      alertId: userAlert ? userAlert.id : null,
    };

    return NextResponse.json(responseData);
  } catch (error) {
    console.error('Error fetching product details:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}