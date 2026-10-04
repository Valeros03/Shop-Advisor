import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { PrismaClient } from "@prisma/client";

// Istanza Prisma globale singleton
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

interface MarketOption {
  market: "IT" | "FR" | "DE";
  price: number;
  url: string;
}

/**
 * Helper sicuro per validare il JWT dal cookie HTTP-Only ed estrarre l'ID utente
 */
async function getAuthenticatedUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get("shopadvisor-auth")?.value;
    if (!token) return null;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.error("[API_CART_AUTH] TELEGRAM_BOT_TOKEN non configurato!");
      return null;
    }

    const secret = new TextEncoder().encode(botToken);
    const { payload } = await jwtVerify(token, secret);

    // Nel login il JWT salva userId (ID interno Prisma dell'utente)
    const userId = payload.userId as string;
    return userId || null;
  } catch (err) {
    return null;
  }
}

// ==========================================
// 1. GET: Recupera solo i prodotti dell'utente loggato
// ==========================================
export async function GET() {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Non autorizzato. Effettua il login." },
        { status: 401 }
      );
    }

    // Interroga il DB: estrae solo gli alert attivi associati all'utente
    const userAlerts = await prisma.alert.findMany({
      where: {
        userId: userId,
        isActive: true,
      },
      include: {
        product: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const items = userAlerts.map((alert) => {
      const p = alert.product;
      const options: MarketOption[] = [];

      // Calcola il prezzo finale sbarcato (prodotto + spedizione) per ciascun mercato
      if (p.currentPriceIT !== null && p.currentPriceIT > 0) {
        options.push({
          market: "IT",
          price: p.currentPriceIT + (p.shippingIT ?? 0),
          url: `https://www.amazon.it/dp/${p.asin}`,
        });
      }
      if (p.currentPriceFR !== null && p.currentPriceFR > 0) {
        options.push({
          market: "FR",
          price: p.currentPriceFR + (p.shippingFR ?? 0),
          url: `https://www.amazon.fr/dp/${p.asin}`,
        });
      }
      if (p.currentPriceDE !== null && p.currentPriceDE > 0) {
        options.push({
          market: "DE",
          price: p.currentPriceDE + (p.shippingDE ?? 0),
          url: `https://www.amazon.de/dp/${p.asin}`,
        });
      }

      // Trova l'opzione migliore
      const best =
        options.length > 0
          ? options.reduce((min, curr) => (curr.price < min.price ? curr : min))
          : {
              market: "IT" as const,
              price: 0,
              url: `https://www.amazon.it/dp/${p.asin}`,
            };

      return {
        id: alert.id,
        name: p.name || `Amazon (${p.asin})`, // Usa p.name da schema Prisma
        asin: p.asin,
        image: p.image || "/placeholder.png",  // Usa p.image da schema Prisma
        bestPrice: best.price,
        bestMarket: best.market,
        amazonUrl: best.url,
      };
    });

    return NextResponse.json({ success: true, data: items }, { status: 200 });
  } catch (error: any) {
    console.error("[API_CART_GET] Errore:", error.message);
    return NextResponse.json(
      { success: false, message: "Errore interno durante il recupero del carrello." },
      { status: 500 }
    );
  }
}

// ==========================================
// 2. DELETE: Rimuove il prodotto dall'elenco tracciati
// ==========================================
export async function DELETE(request: Request) {
  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) {
      return NextResponse.json(
        { success: false, message: "Non autorizzato." },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const alertId = searchParams.get("id");

    if (!alertId || typeof alertId !== "string" || alertId.length > 64) {
      return NextResponse.json(
        { success: false, message: "Identificativo alert non valido." },
        { status: 400 }
      );
    }

    // SICUREZZA: deleteMany con doppio vincolo (id E userId)
    // Impedisce a qualsiasi utente di eliminare un alert appartenente a un altro utente
    const deleteResult = await prisma.alert.deleteMany({
      where: {
        id: alertId,
        userId: userId,
      },
    });

    if (deleteResult.count === 0) {
      return NextResponse.json(
        { success: false, message: "Alert non trovato o non autorizzato." },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, message: "Prodotto rimosso dal tracciamento." },
      { status: 200 }
    );
  } catch (error: any) {
    console.error("[API_CART_DELETE] Errore:", error.message);
    return NextResponse.json(
      { success: false, message: "Errore durante la rimozione del prodotto." },
      { status: 500 }
    );
  }
}