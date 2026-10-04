"use client";

import Link from "next/link";
import Image from "next/image";
import { ShoppingCart } from "lucide-react";
import LogoutButton from "./LogoutButton"; // Assicurati che il percorso del file LogoutButton sia corretto

export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 w-full bg-white border-b border-gray-200 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Logo / Home link */}
        <Link href="/" className="flex items-center gap-2">
          <Image 
            src="/logo.png" 
            alt="ShopAdvisor Logo" 
            width={32} 
            height={32} 
            className="object-contain" 
          />
          <span className="font-extrabold text-xl text-gray-900 tracking-tight">
            Shop<span className="text-[#2b8a3e]">Advisor</span>
          </span>
        </Link>

        {/* Link di Navigazione e Azioni */}
        <div className="flex items-center gap-4">
          <Link 
            href="/cart" 
            className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-[#2b8a3e] px-3 py-2 rounded-xl transition-colors"
          >
            <ShoppingCart className="w-5 h-5" />
            <span>Tracciati</span>
          </Link>

          {/* Il pulsante Esci che abbiamo creato */}
          <LogoutButton />
        </div>

      </div>
    </header>
  );
}