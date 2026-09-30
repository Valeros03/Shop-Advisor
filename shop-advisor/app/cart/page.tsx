"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation"; // Usato per la navigazione dinamica in Next.js 13+
import { Trash2, ExternalLink, Info, ShoppingCart, ChevronLeft } from "lucide-react";
import Link from "next/link";

// Definiamo i tipi del nostro carrello/tracker
interface CartItem {
  id: number;
  name: string;
  asin: string;
  image: string;
  bestPrice: number;
  bestMarket: "IT" | "FR" | "DE";
  amazonUrl: string;
}

// MOCK DATA: Simuliamo i prodotti salvati nel carrello
const initialCart: CartItem[] = [
  {
    id: 1,
    name: "Sony WH-1000XM5 Cuffie Wireless con Noise Cancelling, Fino a 30 Ore di Autonomia",
    asin: "B09Y2NDXGQ",
    image: "https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=500&q=80",
    bestPrice: 269.00,
    bestMarket: "DE",
    amazonUrl: "https://amazon.de/dp/B09Y2NDXGQ"
  },
  {
    id: 2,
    name: "Apple MacBook Air (M1, 2020) - Grigio Siderale",
    asin: "B08N5XHLWV",
    image: "https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?w=500&q=80",
    bestPrice: 899.00,
    bestMarket: "FR",
    amazonUrl: "https://amazon.fr/dp/B08N5XHLWV"
  },
  {
    id: 3,
    name: "Tastiera Meccanica Custom Keychron V1",
    asin: "B0B2DM6X3Y",
    image: "https://images.unsplash.com/photo-1595225476474-87563907a212?w=500&q=80",
    bestPrice: 119.00,
    bestMarket: "IT",
    amazonUrl: "https://amazon.it/dp/B0B2DM6X3Y"
  }
];

export default function CartPage() {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<CartItem[]>(initialCart);

  // Funzione per navigare alla pagina prodotto
  const handleRowClick = (asin: string) => {
    router.push(`/product/${asin}`);
  };

  // Funzione per rimuovere un prodotto
  const handleRemove = (e: React.MouseEvent, id: number) => {
    e.stopPropagation(); // BLOCCA il click per evitare che si apra anche la pagina prodotto
    setCartItems(cartItems.filter(item => item.id !== id));
    console.log("Rimosso prodotto con id:", id);
    // TODO: Chiamata API per rimozione da DB
  };

  // Funzione per il click sul link Amazon
  const handleAmazonClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Ferma il click dal propagarsi alla riga principale
  };

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      
      {/* Intestazione */}
      <div className="flex items-center gap-3 mb-8">
        <ShoppingCart className="text-[#2b8a3e] w-8 h-8" />
        <h1 className="text-3xl font-extrabold text-white">Prodotti Tracciati</h1>
      </div>

      {/* Lista del Carrello */}
      <div className="flex flex-col gap-4 mb-10">
        {cartItems.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-12 text-center flex flex-col items-center">
            <ShoppingCart className="text-gray-600 w-16 h-16 mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">Non stai tracciando nessun prodotto</h2>
            <p className="text-gray-400 mb-6">Cerca un prodotto su Amazon e inizia a tracciare i suoi prezzi.</p>
            <Link href="/" className="bg-[#2b8a3e] hover:bg-[#227031] text-white px-6 py-3 rounded-full font-bold transition-colors">
              Inizia a cercare
            </Link>
          </div>
        ) : (
          cartItems.map((item) => (
            <div 
              key={item.id}
              onClick={() => handleRowClick(item.asin)}
              className="bg-white rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center gap-6 shadow-sm border border-gray-100 hover:shadow-xl hover:border-[#2b8a3e]/30 cursor-pointer transition-all group relative overflow-hidden"
            >
              {/* Barra colorata per abbellire l'hover */}
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-transparent group-hover:bg-[#2b8a3e] transition-colors" />

              {/* Immagine */}
              <div className="relative w-full md:w-28 h-32 md:h-28 bg-gray-50 rounded-xl overflow-hidden flex-shrink-0">
                <Image 
                  src={item.image} 
                  alt={item.name} 
                  fill 
                  className="object-cover group-hover:scale-105 transition-transform duration-500" 
                  sizes="(max-width: 768px) 100vw, 150px"
                />
              </div>

              {/* Dettagli Prodotto */}
              <div className="flex-grow flex flex-col justify-center">
                <div className="text-xs font-mono text-gray-400 mb-1 tracking-wider uppercase">
                  ASIN: {item.asin}
                </div>
                <h3 className="text-lg font-bold text-gray-900 leading-tight mb-2 line-clamp-2 group-hover:text-[#2b8a3e] transition-colors">
                  {item.name}
                </h3>
              </div>

              {/* Prezzo e Mercato */}
              <div className="flex flex-row md:flex-col items-center md:items-end justify-between w-full md:w-auto gap-2 md:gap-1 pl-0 md:pl-4 md:border-l border-gray-100 min-w-[120px]">
                <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Miglior Prezzo</span>
                <div className="text-2xl font-black text-gray-900">{item.bestPrice.toFixed(2)}€</div>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-gray-100 text-gray-700">
                  {item.bestMarket === 'IT' && '🇮🇹 Italia'}
                  {item.bestMarket === 'FR' && '🇫🇷 Francia'}
                  {item.bestMarket === 'DE' && '🇩🇪 Germania'}
                </span>
              </div>

              {/* Azioni (Bottoni separati) */}
              <div className="flex flex-row items-center gap-3 w-full md:w-auto mt-2 md:mt-0 pt-4 md:pt-0 border-t md:border-t-0 border-gray-100">
                <a 
                  href={item.amazonUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  onClick={handleAmazonClick}
                  className="flex-grow md:flex-grow-0 flex justify-center items-center gap-2 bg-[#ff9900]/10 text-[#ff9900] hover:bg-[#ff9900] hover:text-white px-4 py-2.5 md:py-3 md:px-5 rounded-xl font-bold text-sm transition-colors"
                  title="Acquista su Amazon"
                >
                  <ExternalLink size={18} />
                  <span className="md:hidden">Apri</span>
                </a>
                
                <button
                  onClick={(e) => handleRemove(e, item.id)}
                  className="flex-shrink-0 text-gray-400 hover:text-red-500 hover:bg-red-50 bg-gray-50 p-2.5 md:p-3 rounded-xl transition-colors"
                  title="Smetti di tracciare"
                >
                  <Trash2 size={20} />
                </button>
              </div>

            </div>
          ))
        )}
      </div>

      {/* BANNER SPEDIZIONE MULTIPLA */}
      {cartItems.length > 0 && (
        <div className="bg-gray-800/60 border-l-4 border-blue-500 p-5 rounded-r-xl flex items-start gap-4 shadow-md">
          <Info className="w-6 h-6 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-white font-bold text-sm mb-1">Acquisti multipli dallo stesso mercato</h4>
            <p className="text-sm text-gray-300 leading-relaxed">
              In caso di acquisto di più prodotti provenienti dallo stesso paese (es. due articoli da Amazon Francia), 
              il costo totale della spedizione calcolato in questa lista rappresenta il <strong>limite massimo teorico</strong>. 
              Nella maggior parte dei casi, Amazon raggrupperà i tuoi pacchi e <strong className="text-white font-semibold">il costo reale di spedizione al checkout sarà inferiore</strong> alla somma che vedi qui.
            </p>
          </div>
        </div>
      )}

    </main>
  );
}