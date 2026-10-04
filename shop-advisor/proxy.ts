import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// ==========================================
// 1. STRUTTURA RATE LIMITING IN MEMORIA
// ==========================================
interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

// Pulizia periodica ogni 5 minuti per evitare memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (now > record.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

function checkRateLimit(request: NextRequest, pathname: string): NextResponse | null {
  // Rilevamento IP affidabile dietro reverse proxy / Docker
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';

  const now = Date.now();
  const WINDOW_MS = 60 * 1000; // Finestra di 1 minuto

  // Soglie differenziate per proteggere gli endpoint più delicati
  let maxRequests = 60; // 60 req/min per API standard
  let category = 'api-general';

  if (pathname.startsWith('/api/auth/')) {
    maxRequests = 10; // Max 10 tentativi al minuto (Anti-Brute Force su Telegram login)
    category = 'api-auth';
  } else if (pathname.startsWith('/api/products/search')) {
    maxRequests = 25; // Max 25 ricerche al minuto (Anti-Scraping / DoS sul DB)
    category = 'api-search';
  } else if (pathname.startsWith('/api/alerts')) {
    maxRequests = 20; // Max 20 operazioni su alert al minuto
    category = 'api-alerts';
  }

  const recordKey = `${ip}:${category}`;
  const record = rateLimitMap.get(recordKey);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(recordKey, { count: 1, resetTime: now + WINDOW_MS });
  } else {
    record.count += 1;
    if (record.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((record.resetTime - now) / 1000));
      return new NextResponse(
        JSON.stringify({
          error: 'Troppe richieste. Riprova tra qualche istante.',
          retryAfter: retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': retryAfterSeconds.toString(),
          },
        }
      );
    }
  }

  return null;
}

// ==========================================
// 2. MIDDLEWARE PRINCIPALE
// ==========================================
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // --- DIFESA A: Rate Limiting su tutte le route /api/ ---
  if (pathname.startsWith('/api/')) {
    // Escludiamo dal rate limit la verifica interna se invocata dal server stesso
    if (pathname !== '/api/auth/verify') {
      const rateLimitResponse = checkRateLimit(request, pathname);
      if (rateLimitResponse) return rateLimitResponse;
    }
    // Per le altre API lasciamo proseguire verso la route handler dedicata
    return NextResponse.next();
  }

  // --- DIFESA B: Security Headers HTTP globali ---
  const applySecurityHeaders = (res: NextResponse) => {
    // Impedisce clickjacking (incapsulamento in iframe malevoli)
    res.headers.set('X-Frame-Options', 'DENY');
    // Blocca sniffing del Content-Type da parte dei browser
    res.headers.set('X-Content-Type-Options', 'nosniff');
    // Forza isolamento referrer
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    return res;
  };

  // --- DIFESA C: Autenticazione Pagine Frontend ---
  const token = request.cookies.get('shopadvisor-auth')?.value;
  const isLoginPage = pathname.startsWith('/login');

  if (!token) {
    if (!isLoginPage) {
      return applySecurityHeaders(NextResponse.redirect(new URL('/login', request.url)));
    }
    return applySecurityHeaders(NextResponse.next());
  }

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN non configurato');
    }

    const secret = new TextEncoder().encode(botToken);
    // Decodifica e verifica integrità del JWT
    const { payload } = await jwtVerify(token, secret);

    // Controllo sul DB con timeout di sicurezza per non bloccare la pagina se il DB rallenta
    const verifyUrl = new URL('/api/auth/verify', request.url);
    const telegramId = payload.telegramId || payload.id;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout max

    const dbCheck = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId }),
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!dbCheck.ok) {
      throw new Error('Utente revocato o inesistente nel database');
    }

    if (isLoginPage) {
      return applySecurityHeaders(NextResponse.redirect(new URL('/', request.url)));
    }

    return applySecurityHeaders(NextResponse.next());
  } catch (error) {
    console.warn('[Proxy Auth] Sessione non valida o utente rimosso:', (error as Error).message);

    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('shopadvisor-auth');
    return applySecurityHeaders(response);
  }
}

// Configura il matcher includendo sia le API (per il rate limit) sia le pagine (escludendo solo asset statici)
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|logo.png).*)'],
};