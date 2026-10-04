import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST() {
  try {
    const cookieStore = await cookies();

    // Rimuove esplicitamente il cookie di sessione impostando Max-Age=0
    cookieStore.set('shopadvisor-auth', '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });

    return NextResponse.json({ success: true, message: 'Logout effettuato' }, { status: 200 });
  } catch (error: any) {
    console.error('Errore durante il logout:', error);
    return NextResponse.json({ error: 'Errore interno durante il logout' }, { status: 500 });
  }
}