// components/Navbar.tsx
"use client";

import { ShoppingCart, LogOut } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import Image from "next/image"; 

export default function Navbar() {
  const pathname = usePathname();
  const router = useRouter();

  // Escludiamo la Navbar dalla pagina di login
  if (pathname === '/login') {
    return null;
  }

  const handleLogout = (): void => {
    // Elimina il cookie invalidandone la data di scadenza
    document.cookie = "shopadvisor-auth=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    router.push('/login'); 
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex justify-between items-center">
        
        {/* Logo Brand */}
        <div 
          className="flex items-center gap-3 cursor-pointer" 
          onClick={() => router.push('/dashboard')}
        >
          <div className="relative h-16 w-32">
             <Image 
               src="/logo.png" 
               alt="Shop Advisor Logo" 
               fill
               className="object-contain drop-shadow-sm"
               priority
             />
          </div>
        </div>
        
        {/* Actions */}
        <div className="flex items-center gap-3 md:gap-5">
          {/* BOTTONE CARRELLO FUNZIONANTE */}
          <button 
            onClick={() => router.push('/cart')}
            className="flex items-center gap-2 px-4 py-2 bg-[#2b8a3e] text-white rounded-xl shadow-sm hover:bg-[#227031] transition-all font-semibold hover:shadow-md active:scale-95"
          >
            <ShoppingCart size={20} />
            <span className="hidden sm:inline">Carrello</span>
          </button>
          
          <button 
            onClick={handleLogout}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-xl shadow-sm hover:bg-gray-100 hover:text-red-600 transition-all font-medium active:scale-95"
          >
            <LogOut size={20} />
            <span className="hidden sm:inline">Esci</span>
          </button>
        </div>
      </div>
    </header>
  );
}