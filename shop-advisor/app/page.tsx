// app/page.tsx
"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { Search, TrendingUp, BellRing, LineChart, Info, ExternalLink, ChevronLeft, Loader2 } from "lucide-react";
import Link from "next/link"; 

interface Product {
  id: string;
  name: string;
  asin: string;
  saves: number;
  price: string;
  image: string;
  market: string;
  amazonUrl: string; 
}

export default function DashboardPage() {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [hasSearched, setHasSearched] = useState<boolean>(false); 
  const [topProducts, setTopProducts] = useState<Product[]>([]);
  const [searchResults, setSearchResults] = useState<Product[]>([]);
  const [isLoadingTop, setIsLoadingTop] = useState<boolean>(true);
  const [isLoadingSearch, setIsLoadingSearch] = useState<boolean>(false);

  useEffect(() => {
    const fetchTopProducts = async () => {
      try {
        const res = await fetch('/api/products/top');
        if (res.ok) {
          const data = await res.json();
          setTopProducts(data);
        }
      } catch (error) {
        console.error("Failed to fetch top products:", error);
      } finally {
        setIsLoadingTop(false);
      }
    };

    fetchTopProducts();
  }, []);

  const handleSearch = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setHasSearched(true);
    setIsLoadingSearch(true);

    try {
      const res = await fetch(`/api/products/search?q=${encodeURIComponent(searchQuery)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch (error) {
      console.error("Failed to search products:", error);
    } finally {
      setIsLoadingSearch(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    
    if (value.trim() === "") {
      setHasSearched(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setHasSearched(false);
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      
      {/* HEADER */}
      <div className="text-center mb-12">
        <h1 className="text-3xl md:text-4xl font-extrabold text-white mb-4 tracking-tight">
          Traccia, confronta e <span className="text-[#2b8a3e]">risparmia.</span>
        </h1>
        <p className="text-gray-300 max-w-2xl mx-auto text-lg">
          Monitora l&apos;andamento dei prezzi su Amazon IT, FR e DE. Imposta la tua soglia e ricevi alert su Telegram quando è il momento perfetto per acquistare.
        </p>
      </div>

      {/* SEARCH BAR */}
      <div className="max-w-3xl mx-auto mb-12">
        <form onSubmit={handleSearch} className="relative group">
          <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
            <Search className="h-6 w-6 text-gray-400 group-focus-within:text-[#2b8a3e] transition-colors" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={handleInputChange}
            className="block w-full pl-14 pr-32 py-5 border border-gray-300 rounded-full leading-5 bg-white text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#2b8a3e] focus:border-[#2b8a3e] sm:text-lg shadow-sm transition-all hover:shadow-md"
            placeholder="Cerca un prodotto dal nome o tramite ASIN..."
          />
          <button
            type="submit"
            className="absolute right-2 top-2 bottom-2 bg-[#2b8a3e] text-white px-6 md:px-8 rounded-full font-bold hover:bg-[#227031] transition-colors shadow-sm"
          >
            Cerca
          </button>
        </form>
      </div>

      {/* CONTENUTO DINAMICO: Risultati di Ricerca vs Home */}
      {!hasSearched ? (
        /* VISTA HOME: I Più Seguiti */
        <div className="mb-12 animate-in fade-in duration-500">
          <div className="flex items-center gap-2 mb-8">
            <TrendingUp className="text-[#2b8a3e] h-7 w-7" />
            <h2 className="text-2xl font-bold text-white">I più seguiti dalla community</h2>
          </div>
          
          {isLoadingTop ? (
            <div className="flex justify-center items-center py-20">
              <Loader2 className="w-10 h-10 text-[#2b8a3e] animate-spin" />
            </div>
          ) : topProducts.length === 0 ? (
            <div className="text-center py-10 text-gray-400">Nessun prodotto trovato.</div>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {topProducts.map((product) => (
              <div 
                key={product.id} 
                className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 group flex flex-col"
              >
                
                <div className="relative h-56 bg-gray-50 rounded-2xl mb-5 overflow-hidden flex justify-center items-center">
                  <Image 
                    src={product.image} 
                    alt={product.name}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                    sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                  />
                  
                  <div className="absolute top-3 right-3 z-10 bg-white/95 backdrop-blur-sm text-xs font-bold px-3 py-1.5 rounded-full shadow-sm text-gray-700 border border-gray-100 flex items-center gap-1.5">
                    <BellRing size={14} className={product.saves > 0 ? "text-[#2b8a3e]" : "text-gray-400"} /> 
                    {product.saves} {product.saves === 1 ? 'Alert' : 'Alerts'}
                  </div>
                </div>

                <div className="flex-grow">
                  <div className="text-xs font-mono text-gray-400 mb-2 uppercase tracking-wider">
                    ASIN: {product.asin}
                  </div>
                  <h3 className="font-bold text-lg text-gray-800 leading-tight mb-4 line-clamp-2" title={product.name}>
                    {product.name}
                  </h3>
                </div>

                <div className="flex justify-between items-end pt-4 border-t border-gray-100 mt-auto">
                  <div>
                    <div className="flex items-center gap-2 mb-1 text-xs font-medium text-gray-500">
                      Miglior Prezzo Attuale
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-700">
                        {product.market === 'IT' && '🇮🇹 IT'}
                        {product.market === 'FR' && '🇫🇷 FR'}
                        {product.market === 'DE' && '🇩🇪 DE'}
                      </span>
                    </div>
                    <span className="text-2xl font-black text-gray-900">{product.price}</span>
                  </div>
                  <Link href={`/product/${product.asin}`} className="flex items-center gap-2 text-[#2b8a3e] bg-[#2b8a3e]/10 hover:bg-[#2b8a3e] hover:text-white px-4 py-2.5 rounded-xl transition-all text-sm font-bold">
                    <LineChart size={18} />
                    Storico
                  </Link>
                </div>
              </div>
            ))}
          </div>
          )}
        </div>
      ) : (
        /* VISTA RICERCA: Risultati */
        <div className="mb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
          
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white">Risultati per &quot;{searchQuery}&quot;</h2>
              {!isLoadingSearch && <p className="text-gray-400 text-sm mt-1">Trovati {searchResults.length} prodotti</p>}
            </div>
            <button 
              onClick={clearSearch}
              className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <ChevronLeft size={16} /> Torna alla home
            </button>
          </div>

          {isLoadingSearch ? (
            <div className="flex justify-center items-center py-20">
              <Loader2 className="w-10 h-10 text-[#2b8a3e] animate-spin" />
            </div>
          ) : searchResults.length === 0 ? (
            <div className="text-center py-10 text-gray-400">Nessun prodotto trovato.</div>
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {searchResults.map((product) => (
              <div 
                key={product.id} 
                className="bg-white rounded-3xl p-5 shadow-sm border border-gray-100 hover:shadow-xl transition-all duration-300 group flex flex-col relative"
              >
                <Link href={`/product/${product.asin}`} className="block flex-grow cursor-pointer">
                  
                  <div className="relative h-48 bg-gray-50 rounded-2xl mb-4 overflow-hidden flex justify-center items-center">
                    <Image 
                      src={product.image} 
                      alt={product.name}
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                    />
                  </div>

                  <div className="text-xs font-mono text-gray-400 mb-1.5 uppercase tracking-wider">
                    ASIN: {product.asin}
                  </div>
                  <h3 className="font-bold text-[15px] text-gray-800 leading-snug mb-3 line-clamp-3 group-hover:text-[#2b8a3e] transition-colors">
                    {product.name}
                  </h3>
                </Link>

                <div className="pt-4 border-t border-gray-100 mt-auto flex flex-col gap-3">
                  <div className="flex justify-between items-center">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-gray-400 font-semibold uppercase mb-0.5">Miglior Prezzo</span>
                      <span className="text-xl font-black text-gray-900 leading-none">{product.price}</span>
                    </div>
                    
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-bold bg-gray-100 text-gray-700">
                      {product.market === 'IT' && '🇮🇹 IT'}
                      {product.market === 'FR' && '🇫🇷 FR'}
                      {product.market === 'DE' && '🇩🇪 DE'}
                    </span>
                  </div>

                  {product.amazonUrl ? (
                  <a 
                    href={product.amazonUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="w-full flex justify-center items-center gap-2 bg-[#ff9900]/10 text-[#ff9900] hover:bg-[#ff9900] hover:text-white px-4 py-2.5 rounded-xl font-bold text-sm transition-colors"
                  >
                    <ExternalLink size={16} />
                    Apri su Amazon
                  </a>
                  ) : (
                    <div className="w-full flex justify-center items-center gap-2 bg-gray-100 text-gray-400 px-4 py-2.5 rounded-xl font-bold text-sm">
                      Non disponibile
                    </div>
                  )}
                </div>

              </div>
            ))}
          </div>
          )}

        </div>
      )}

      {/* BANNER DISCLAIMER SEMPRE VISIBILE */}
      <div className="mt-8 bg-gray-800/60 border-l-4 border-[#2b8a3e] p-4 rounded-r-lg flex items-start gap-3 shadow-sm">
        <Info className="w-5 h-5 text-[#2b8a3e] flex-shrink-0 mt-0.5" />
        <p className="text-sm text-gray-300 leading-relaxed">
          I prezzi calcolati sono il prezzo finale che vedrai all&apos;acquisto di quel prodotto, comprendono IVA e spedizione, anche cross-market. <strong className="text-white font-semibold">TUTTAVIA</strong> il prezzo finale può variare se quel prodotto cambia prezzo nell&apos;arco della giornata più volte.
        </p>
      </div>

    </main>
  );
}