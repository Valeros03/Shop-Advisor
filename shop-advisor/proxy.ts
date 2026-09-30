import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

export async function proxy(request: NextRequest) {
  const token = request.cookies.get('shopadvisor-auth')?.value;
  const isLoginPage = request.nextUrl.pathname.startsWith('/login');

  if (!token) {
    if (!isLoginPage) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return NextResponse.next();
  }

  try {
    const secret = new TextEncoder().encode(process.env.TELEGRAM_BOT_TOKEN);
    // 1. Decodifichiamo il token JWT
    const { payload } = await jwtVerify(token, secret);
    
    // === 2. NUOVO CONTROLLO SUL DATABASE ===
    const verifyUrl = new URL('/api/auth/verify', request.url);
    const telegramId = payload.id || payload.telegramId; 
    
    const dbCheck = await fetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramId }),
      cache: 'no-store'
    });

    if (!dbCheck.ok) {
      throw new Error("Utente non più presente nel database");
    }
    // ========================================

    if (isLoginPage) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    
    return NextResponse.next();
  } catch (error) {
    console.log("Accesso negato: Token scaduto o Utente rimosso dal DB");
    
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.delete('shopadvisor-auth');
    return response;
  }
}

// Il matcher funziona esattamente come prima
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|logo.png).*)'],
};