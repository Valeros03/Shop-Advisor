"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { 
  ChevronLeft, Bell, AlertTriangle, ExternalLink, Info, 
  TrendingDown, TrendingUp, CheckCircle2, Loader2, Crown
} from "lucide-react";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from "recharts";

export default function ProductPage() {
  const params = useParams();
  const asin = params?.asin as string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [productData, setProductData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [alertPrice, setAlertPrice] = useState<string>("");
  const [isSaved, setIsSaved] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!asin) return;

    const fetchProduct = async () => {
      try {
        const res = await fetch(`/api/products/${asin}`);
        if (!res.ok) {
          throw new Error("Product not found");
        }
        const data = await res.json();
        setProductData(data);
        setAlertPrice(data.recommendedPrice.toString());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProduct();
  }, [asin]);

  const parsedAlertPrice = parseFloat(alertPrice) || 0;
  const isPriceTooLow = 
    productData && 
    productData.hasLongHistory && 
    parsedAlertPrice > 0 && 
    parsedAlertPrice < (productData.absoluteMin * 0.80);

  const isNewTracking = productData && !productData.hasLongHistory;

  const handleSaveAlert = async () => {
    if (!asin || parsedAlertPrice <= 0) return;

    setIsSaving(true);
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          asin,
          targetPrice: parsedAlertPrice,
        }),
      });

      if (res.ok) {
        setIsSaved(true);
      } else {
        const data = await res.json();
        if (data.error === 'Unauthorized') {
          alert('Devi effettuare il login con Telegram prima di poter salvare un alert.');
        } else {
          alert(`Errore: ${data.error}`);
        }
      }
    } catch (err) {
      console.error("Failed to save alert:", err);
      alert('Si è verificato un errore durante il salvataggio dell\'alert.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh]">
        <Loader2 className="w-12 h-12 text-[#2b8a3e] animate-spin mb-4" />
        <p className="text-gray-400">Caricamento dettagli prodotto...</p>
      </div>
    );
  }

  if (error || !productData) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-20 text-center">
        <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2">Prodotto non trovato</h2>
        <p className="text-gray-400 mb-8">Non siamo riusciti a trovare il prodotto con ASIN {asin}.</p>
        <Link href="/" className="inline-flex items-center gap-2 bg-[#2b8a3e] text-white px-6 py-3 rounded-full font-bold hover:bg-[#227031] transition-colors">
          <ChevronLeft size={20} /> Torna alla ricerca
        </Link>
      </div>
    );
  }

  const { product: productMock, marketsStats, chartData } = productData;

  const marketsWithPrime = marketsStats.map((m: any) => {
    const isPrime = m.isPrimeExclusive ?? 
                    (m.code === "IT" && productMock.isPrimeExclusiveIT) ??
                    (m.code === "FR" && productMock.isPrimeExclusiveFR) ??
                    (m.code === "DE" && productMock.isPrimeExclusiveDE) ?? 
                    false;
    return { ...m, isPrimeExclusive: isPrime };
  });

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      
      {/* Navigazione */}
      <Link href="/" className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-6">
        <ChevronLeft size={20} /> Torna alla ricerca
      </Link>

      {/* HEADER PRODOTTO */}
      <div className="flex flex-col md:flex-row gap-6 items-start mb-8 bg-gray-900/50 p-6 rounded-3xl border border-gray-800">
        <div className="relative w-32 h-32 md:w-40 md:h-40 bg-white rounded-2xl overflow-hidden flex-shrink-0">
          <Image src={productMock.image} alt={productMock.name} fill className="object-cover" />
        </div>
        <div className="flex-grow">
          <div className="text-sm font-mono text-gray-400 mb-2 uppercase tracking-wider">
            ASIN: {productMock.asin}
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-white leading-tight mb-4">
            {productMock.name}
          </h1>
          
          <div className="flex items-start gap-2 bg-blue-900/20 border border-blue-900/50 p-3 rounded-xl inline-flex text-blue-200 text-sm max-w-2xl">
            <Info className="w-5 h-5 flex-shrink-0 mt-0.5 text-blue-400" />
            <p>
              I prezzi mostrati su questa pagina sono <strong>Finali</strong>. Includono già l&apos;adeguamento IVA per l&apos;Italia e i costi di spedizione stimati.
            </p>
          </div>
        </div>
      </div>

      {/* GRIGLIA PRINCIPALE: GRAFICO + TRACKER BOX */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        
        {/* COLONNA SINISTRA: Grafico Storico */}
        <div className="lg:col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-gray-900">Storico Prezzi (1 Anno)</h2>
            <div className="text-sm text-gray-500 font-medium">Prezzi finali inclusivi di spedizione</div>
          </div>
          
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} unit="€" domain={['dataMin - 10', 'dataMax + 10']} />
                
                {/* TOOLTIP PERSONALIZZATO CON BADGE PRIME ACCANTO AL PREZZO */}
                <Tooltip 
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;

                    return (
                      <div className="bg-[#111827] border border-gray-700 p-3 rounded-xl shadow-xl text-white min-w-[170px]">
                        <div className="text-xs font-bold text-gray-400 mb-2 border-b border-gray-700/80 pb-1">
                          {label}
                        </div>
                        <div className="flex flex-col gap-2">
                          {payload.map((entry: any) => {
                            const marketKey = entry.dataKey; // "IT", "FR", "DE"
                            const isPrime = entry.payload?.[`${marketKey}_isPrime`];

                            return (
                              <div key={marketKey} className="flex items-center justify-between gap-3 text-sm">
                                <span className="font-bold flex items-center gap-1.5" style={{ color: entry.color }}>
                                  <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                                  {entry.name}:
                                </span>
                                
                                <span className="font-extrabold text-white flex items-center gap-1.5">
                                  {entry.value !== null && entry.value !== undefined ? `${Number(entry.value).toFixed(2)}€` : "N/D"}
                                  {isPrime && (
                                    <span 
                                      title="Offerta esclusiva Prime"
                                      className="inline-flex items-center gap-0.5 bg-amber-400 text-black text-[10px] font-black px-1.5 py-0.2 rounded-full shadow-sm"
                                    >
                                      👑 Prime
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />

                <Legend iconType="circle" wrapperStyle={{ fontSize: '14px', paddingTop: '10px' }} />
                
                <Line 
                  type="monotone" 
                  dataKey="IT" 
                  name="Amazon IT" 
                  stroke="#2b8a3e" 
                  strokeWidth={3} 
                  dot={{ r: 4, strokeWidth: 1, fill: '#2b8a3e' }} 
                  activeDot={{ r: 6 }} 
                  connectNulls 
                />
                <Line 
                  type="monotone" 
                  dataKey="FR" 
                  name="Amazon FR" 
                  stroke="#3b82f6" 
                  strokeWidth={3} 
                  dot={{ r: 4, strokeWidth: 1, fill: '#3b82f6' }} 
                  activeDot={{ r: 6 }} 
                  connectNulls 
                />
                <Line 
                  type="monotone" 
                  dataKey="DE" 
                  name="Amazon DE" 
                  stroke="#f59e0b" 
                  strokeWidth={3} 
                  dot={{ r: 4, strokeWidth: 1, fill: '#f59e0b' }} 
                  activeDot={{ r: 6 }} 
                  connectNulls 
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* COLONNA DESTRA: Box Gestione / Attivazione Alert */}
        <div className="bg-gray-800 rounded-3xl p-6 border-2 border-gray-700 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Bell className={productData.isUserTracking ? "text-green-400 w-6 h-6 animate-pulse" : "text-[#2b8a3e] w-6 h-6"} />
                <h2 className="text-xl font-bold text-white">
                  {productData.isUserTracking ? "Prodotto Tracciato" : "Traccia questo prodotto"}
                </h2>
              </div>
              {productData.isUserTracking && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/20 text-green-300 border border-green-500/30">
                  <CheckCircle2 size={13} /> Attivo
                </span>
              )}
            </div>

            <p className="text-gray-400 text-sm mb-4">
              {productData.isUserTracking
                ? "Riceverai una notifica Telegram appena una delle offerte scende sotto la tua soglia."
                : "Ti invieremo un messaggio su Telegram appena il prezzo finale scende sotto la tua soglia."}
            </p>

            {productData.isUserTracking && productData.currentAlertPrice && (
              <div className="mb-4 p-3 bg-gray-900/80 rounded-xl border border-gray-700/60 flex items-center justify-between">
                <div>
                  <div className="text-[11px] text-gray-400 font-bold uppercase tracking-wider">Soglia attuale impostata</div>
                  <div className="text-xl font-black text-green-400">{productData.currentAlertPrice.toFixed(2)}€</div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!confirm("Vuoi smettere di tracciare questo prodotto?")) return;
                    setIsSaving(true);
                    try {
                      const res = await fetch(`/api/alerts?asin=${asin}`, { method: "DELETE" });
                      if (res.ok) {
                        setProductData({ ...productData, isUserTracking: false, currentAlertPrice: null });
                      }
                    } finally {
                      setIsSaving(false);
                    }
                  }}
                  className="text-xs text-red-400 hover:text-red-300 underline font-semibold transition-colors"
                >
                  Rimuovi tracciamento
                </button>
              </div>
            )}

            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-semibold text-gray-300">
                {productData.isUserTracking ? "Modifica Soglia Alert (€)" : "Prezzo Desiderato (€)"}
              </label>
              {productData.recommendedPrice > 0 && (
                <button
                  type="button"
                  onClick={() => setAlertPrice(productData.recommendedPrice.toString())}
                  className="text-xs text-[#2b8a3e] hover:text-green-400 font-bold transition-colors underline"
                  title="Applica il prezzo calcolato dal sistema"
                >
                  Suggerito: {productData.recommendedPrice.toFixed(2)}€
                </button>
              )}
            </div>

            <div className="relative mb-4">
              <input 
                type="number" 
                step="0.01"
                value={alertPrice}
                onChange={(e) => setAlertPrice(e.target.value)}
                placeholder={productData.recommendedPrice ? productData.recommendedPrice.toString() : "0.00"}
                className="w-full bg-gray-900 border border-gray-600 text-white text-2xl font-bold rounded-xl py-4 pl-6 pr-12 focus:outline-none focus:border-[#2b8a3e] focus:ring-1 focus:ring-[#2b8a3e] transition-colors"
              />
              <span className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-400 text-xl font-bold">€</span>
            </div>

            {isPriceTooLow ? (
              <div className="bg-orange-500/10 border border-orange-500/30 p-3 rounded-lg flex items-start gap-3 mb-4 animate-in fade-in">
                <AlertTriangle className="text-orange-500 w-5 h-5 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-orange-200 leading-tight">
                  Questo prezzo è inferiore di oltre il 20% rispetto al minimo storico registrato ({productData.absoluteMin.toFixed(2)}€). Potrebbe richiedere tempo per essere raggiunto.
                </p>
              </div>
            ) : isNewTracking && parsedAlertPrice > 0 ? (
              <div className="bg-blue-500/10 border border-blue-500/20 p-3 rounded-lg flex items-start gap-3 mb-4 animate-in fade-in">
                <Info className="text-blue-400 w-4 h-4 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-blue-200 leading-tight">
                  Monitoraggio iniziato di recente. Ti avviseremo non appena il prezzo scenderà sotto la soglia impostata.
                </p>
              </div>
            ) : null}
          </div>

          <button 
            onClick={async () => {
              await handleSaveAlert();
              setProductData((prev: any) => ({
                ...prev,
                isUserTracking: true,
                currentAlertPrice: parsedAlertPrice
              }));
            }}
            disabled={isSaving || parsedAlertPrice <= 0}
            className={`w-full py-4 rounded-xl font-bold text-lg flex justify-center items-center gap-2 transition-all shadow-lg ${
              isSaving
                ? "bg-gray-700 text-gray-400 cursor-wait opacity-70"
                : productData.isUserTracking
                  ? "bg-[#2b8a3e] hover:bg-[#227031] text-white"
                  : "bg-[#2b8a3e] hover:bg-[#227031] text-white hover:shadow-green-900/20"
            }`}
          >
            {isSaving ? (
              <><Loader2 className="animate-spin" /> Salvataggio...</>
            ) : productData.isUserTracking ? (
              <><CheckCircle2 /> Aggiorna Prezzo Alert</>
            ) : (
              "Attiva Alert"
            )}
          </button>
        </div>
      </div>

      {/* STATISTICHE MERCATI E BOTTONI AMAZON */}
      <h3 className="text-xl font-bold text-white mb-4">Dettagli per Mercato</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {marketsWithPrime.map((market: any) => (
          <div key={market.code} className="bg-white rounded-3xl p-6 flex flex-col shadow-sm border border-gray-100 relative overflow-hidden">
            
            <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: market.color }} />

            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-2 text-xl font-bold text-gray-900">
                {market.flag} {market.name}
              </div>
              <div className="text-right">
                <div className="flex items-center justify-end gap-1.5 mb-1">
                  <span className="text-[10px] uppercase font-bold text-gray-400">Prezzo Attuale</span>
                  {market.isPrimeExclusive && (
                    <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 border border-amber-300 text-[10px] font-bold px-1.5 py-0.5 rounded-md">
                      <Crown size={11} className="text-amber-600" /> Prime
                    </span>
                  )}
                </div>
                <div className="text-2xl font-black text-gray-900">{market.current ? `${market.current.toFixed(2)}€` : 'N/A'}</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-6 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <div className="text-center">
                <div className="text-xs text-gray-500 mb-1">Minimo</div>
                <div className="font-bold text-gray-800 flex justify-center items-center gap-1">
                  <TrendingDown size={14} className="text-green-600" /> {market.min ? `${market.min.toFixed(2)}€` : 'N/A'}
                </div>
              </div>
              <div className="text-center border-l border-r border-gray-200">
                <div className="text-xs text-gray-500 mb-1">Medio</div>
                <div className="font-bold text-gray-800">{market.avg ? `${market.avg.toFixed(2)}€` : 'N/A'}</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500 mb-1">Massimo</div>
                <div className="font-bold text-gray-800 flex justify-center items-center gap-1">
                  <TrendingUp size={14} className="text-red-500" /> {market.max ? `${market.max.toFixed(2)}€` : 'N/A'}
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center text-sm mb-6 pb-4 border-b border-gray-100">
              <span className="text-gray-500">Costo spedizione calcolato:</span>
              <span className="font-mono font-semibold text-gray-700">
                {market.shipping === 0 ? "Gratuita" : market.shipping ? `+${market.shipping.toFixed(2)}€` : 'N/A'}
              </span>
            </div>

            <a 
              href={market.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="mt-auto w-full flex justify-center items-center gap-2 bg-[#ff9900]/10 text-[#ff9900] hover:bg-[#ff9900] hover:text-white px-4 py-3 rounded-xl font-bold transition-colors"
            >
              <ExternalLink size={18} />
              Vedi su Amazon {market.code}
            </a>
          </div>
        ))}
      </div>

    </main>
  );
}