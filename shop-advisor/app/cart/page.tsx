"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Trash2, ExternalLink, Info, ShoppingCart, Loader2 } from "lucide-react";
import Link from "next/link";

interface CartItem {
  id: string | number;
  name: string;
  asin: string;
  image: string;
  bestPrice: number;
  bestMarket: "IT" | "FR" | "DE";
  amazonUrl: string;
}

export default function CartPage() {
  const router = useRouter();
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadCartData() {
      try {
        setIsLoading(true);
        setErrorMsg(null);

        const res = await fetch("/api/cart", {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
        });

        // Se il JWT è scaduto o l'utente non è loggato, rimanda al login
        if (res.status === 401) {
          router.push("/login");
          return;
        }

        if (!res.ok) {
          throw new Error("Errore durante il recupero dei dati dal server.");
        }

        const json = await res.json();
        if (isMounted) {
          if (json.success && Array.isArray(json.data)) {
            setCartItems(json.data);
          } else {
            setCartItems([]);
          }
        }
      } catch (err: any) {
        if (isMounted) {
          setErrorMsg("Impossibile caricare i prodotti al momento. Riprova più tardi.");
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    loadCartData();
    return () => {
      isMounted = false;
    };
  }, [router]);

  const handleRowClick = (asin: string) => {
    const cleanAsin = asin.replace(/[^A-Za-z0-9]/g, "");
    router.push(`/product/${cleanAsin}`);
  };

  const handleRemove = async (e: React.MouseEvent, id: string | number) => {
    e.stopPropagation();
    if (deletingId) return;

    const previousItems = [...cartItems];
    setCartItems(cartItems.filter((item) => item.id !== id));
    setDeletingId(id);

    try {
      const res = await fetch(`/api/cart?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Cancellazione non riuscita.");
      }
    } catch (err) {
      console.error("Errore rimozione:", err);
      setCartItems(previousItems);
      alert("Si è verificato un errore durante la rimozione del prodotto.");
    } finally {
      setDeletingId(null);
    }
  };

  const handleAmazonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      {/* Intestazione */}
      <div className="flex items-center gap-3 mb-8">
        <ShoppingCart className="text-[#2b8a3e] w-8 h-8" />
        <h1 className="text-3xl font-extrabold text-white">Prodotti Tracciati</h1>
      </div>

      {/* Messaggio Errore */}
      {errorMsg && (
        <div className="mb-6 p-4 rounded-xl bg-red-900/30 border border-red-800 text-red-300 text-sm">
          {errorMsg}
        </div>
      )}

      {/* Lista del Carrello */}
      <div className="flex flex-col gap-4 mb-10">
        {isLoading ? (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-16 text-center flex flex-col items-center justify-center">
            <Loader2 className="w-10 h-10 text-[#2b8a3e] animate-spin mb-3" />
            <p className="text-gray-400 font-medium text-sm">
              Sincronizzazione prodotti tracciati...
            </p>
          </div>
        ) : cartItems.length === 0 ? (
          <div className="bg-gray-900 border border-gray-800 rounded-3xl p-12 text-center flex flex-col items-center">
            <ShoppingCart className="text-gray-600 w-16 h-16 mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">
              Non stai tracciando nessun prodotto
            </h2>
            <p className="text-gray-400 mb-6">
              Cerca un prodotto su Amazon e inizia a tracciare i suoi prezzi.
            </p>
            <Link
              href="/"
              className="bg-[#2b8a3e] hover:bg-[#227031] text-white px-6 py-3 rounded-full font-bold transition-colors"
            >
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
                  unoptimized={item.image.startsWith("http")}
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
                <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">
                  Miglior Prezzo
                </span>
                <div className="text-2xl font-black text-gray-900">
                  {item.bestPrice > 0 ? `${item.bestPrice.toFixed(2)}€` : "N/D"}
                </div>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-gray-100 text-gray-700">
                  {item.bestMarket === "IT" && "🇮🇹 Italia"}
                  {item.bestMarket === "FR" && "🇫🇷 Francia"}
                  {item.bestMarket === "DE" && "🇩🇪 Germania"}
                </span>
              </div>

              {/* Azioni */}
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
                  disabled={deletingId === item.id}
                  onClick={(e) => handleRemove(e, item.id)}
                  className="flex-shrink-0 text-gray-400 hover:text-red-500 hover:bg-red-50 bg-gray-50 p-2.5 md:p-3 rounded-xl transition-colors disabled:opacity-50"
                  title="Smetti di tracciare"
                >
                  <Trash2 size={20} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Banner Spedizione Multipla */}
      {!isLoading && cartItems.length > 0 && (
        <div className="bg-gray-800/60 border-l-4 border-blue-500 p-5 rounded-r-xl flex items-start gap-4 shadow-md">
          <Info className="w-6 h-6 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="text-white font-bold text-sm mb-1">
              Acquisti multipli dallo stesso mercato
            </h4>
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