"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { 
  ChevronLeft, Bell, AlertTriangle, ExternalLink, Info, 
  TrendingDown, TrendingUp, CheckCircle2, Loader2
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
  const isPriceTooLow = productData && parsedAlertPrice > 0 && parsedAlertPrice < (productData.absoluteMin * 0.95);

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

  const { product: productMock, marketsStats, chartData, absoluteMin } = productData;

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
              I prezzi mostrati su questa pagina sono <strong>Finali</strong>. Includono già l&apos;adeguamento IVA per l&apos;Italia e i costi di spedizione stimati. Il prezzo che vedi è quello che pagherai al checkout.
            </p>
          </div>
        </div>
      </div>

      {/* GRIGLIA PRINCIPALE: GRAFICO + TRACKER BOX */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        
        {/* COLONNA SINISTRA: Grafico Storico (Occupa 2 colonne) */}
        <div className="lg:col-span-2 bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-gray-900">Storico Prezzi (1 Anno)</h2>
            <div className="text-sm text-gray-500 font-medium">Prezzi finali inclusivi di spedizione</div>
          </div>
          
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#6b7280', fontSize: 12}} unit="€" domain={['dataMin - 10', 'dataMax + 10']} />
                
                {/* Custom Tooltip per lo sfondo scuro della tua UI */}
                <Tooltip 
                  contentStyle={{ backgroundColor: '#111827', borderRadius: '12px', border: 'none', color: '#fff' }}
                  itemStyle={{ fontWeight: 'bold' }}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '14px', paddingTop: '10px' }} />
                
                <Line type="monotone" dataKey="IT" name="Amazon IT" stroke="#2b8a3e" strokeWidth={3} dot={false} activeDot={{ r: 6 }} />
                <Line type="monotone" dataKey="FR" name="Amazon FR" stroke="#3b82f6" strokeWidth={3} dot={false} />
                <Line type="monotone" dataKey="DE" name="Amazon DE" stroke="#f59e0b" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* COLONNA DESTRA: Box Attivazione Alert */}
        <div className="bg-gray-800 rounded-3xl p-6 border-2 border-gray-700 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Bell className="text-[#2b8a3e] w-6 h-6" />
              <h2 className="text-xl font-bold text-white">Traccia questo prodotto</h2>
            </div>
            <p className="text-gray-400 text-sm mb-6">
              Ti invieremo un messaggio su Telegram appena il prezzo finale scende sotto la tua soglia.
            </p>

            <label className="block text-sm font-semibold text-gray-300 mb-2">
              Prezzo Desiderato (€)
            </label>
            <div className="relative mb-4">
              <input 
                type="number" 
                value={alertPrice}
                onChange={(e) => setAlertPrice(e.target.value)}
                className="w-full bg-gray-900 border border-gray-600 text-white text-2xl font-bold rounded-xl py-4 pl-6 pr-12 focus:outline-none focus:border-[#2b8a3e] focus:ring-1 focus:ring-[#2b8a3e] transition-colors"
              />
              <span className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-400 text-xl font-bold">€</span>
            </div>

            {/* Banner Dinamico se il prezzo è troppo basso */}
            {isPriceTooLow && (
              <div className="bg-orange-500/10 border border-orange-500/30 p-3 rounded-lg flex items-start gap-3 mb-4 animate-in fade-in">
                <AlertTriangle className="text-orange-500 w-5 h-5 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-orange-200 leading-tight">
                  Questo prezzo è inferiore al minimo storico dell&apos;ultimo anno ({absoluteMin.toFixed(2)}€). Potrebbe non essere mai raggiunto.
                </p>
              </div>
            )}
          </div>

          <button 
            onClick={handleSaveAlert}
            disabled={isSaved || isSaving}
            className={`w-full py-4 rounded-xl font-bold text-lg flex justify-center items-center gap-2 transition-all shadow-lg ${
              isSaved 
              ? "bg-gray-700 text-gray-300 cursor-not-allowed" 
              : "bg-[#2b8a3e] hover:bg-[#227031] text-white hover:shadow-green-900/20"
            } ${isSaving ? 'opacity-70 cursor-wait' : ''}`}
          >
            {isSaving ? <><Loader2 className="animate-spin" /> Salvataggio...</> : isSaved ? <><CheckCircle2 /> Alert Attivo</> : "Attiva Alert"}
          </button>
        </div>
      </div>

      {/* STATISTICHE MERCATI E BOTTONI AMAZON */}
      <h3 className="text-xl font-bold text-white mb-4">Dettagli per Mercato</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {marketsStats.map((market: any) => (
          <div key={market.code} className="bg-white rounded-3xl p-6 flex flex-col shadow-sm border border-gray-100 relative overflow-hidden">
            
            {/* Riga Colorata in cima alla card */}
            <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: market.color }} />

            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-2 text-xl font-bold text-gray-900">
                {market.flag} {market.name}
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase font-bold text-gray-400">Prezzo Attuale</div>
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