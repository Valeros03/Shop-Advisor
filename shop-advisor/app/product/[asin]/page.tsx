"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { 
  ChevronLeft, Bell, AlertTriangle, ExternalLink, Info, 
  TrendingDown, TrendingUp, CheckCircle2 
} from "lucide-react";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from "recharts";

// --- MOCK DATA ---
const productMock = {
  name: "Sony WH-1000XM5 Cuffie Wireless con Noise Cancelling",
  asin: "B09Y2NDXGQ",
  image: "https://images.unsplash.com/photo-1618366712010-f4ae9c647dcb?w=500&q=80",
};

// I prezzi finti per il grafico (Ultimi 12 mesi)
// Tutti i prezzi qui sono già "Finali" (IVA normalizzata + Spedizione)
const chartData = [
  { month: "Gen", IT: 315, FR: 320, DE: 310 },
  { month: "Feb", IT: 310, FR: 315, DE: 305 },
  { month: "Mar", IT: 299, FR: 315, DE: 295 },
  { month: "Apr", IT: 305, FR: 299, DE: 300 },
  { month: "Mag", IT: 289, FR: 295, DE: 290 },
  { month: "Giu", IT: 299, FR: 289, DE: 285 },
  { month: "Lug", IT: 279, FR: 285, DE: 280 }, // Prime Day mock
  { month: "Ago", IT: 295, FR: 299, DE: 295 },
  { month: "Set", IT: 289, FR: 295, DE: 290 },
  { month: "Ott", IT: 299, FR: 305, DE: 299 },
  { month: "Nov", IT: 269, FR: 275, DE: 270 }, // Black Friday mock
  { month: "Dic", IT: 299, FR: 299, DE: 295 },
];

const marketsStats = [
  { 
    code: "IT", name: "Italia", flag: "🇮🇹", color: "#2b8a3e",
    current: 299.00, min: 269.00, max: 315.00, avg: 295.50, shipping: 0.00,
    url: "https://amazon.it/dp/B09Y2NDXGQ"
  },
  { 
    code: "FR", name: "Francia", flag: "🇫🇷", color: "#3b82f6",
    current: 299.00, min: 275.00, max: 320.00, avg: 300.20, shipping: 6.99,
    url: "https://amazon.fr/dp/B09Y2NDXGQ"
  },
  { 
    code: "DE", name: "Germania", flag: "🇩🇪", color: "#f59e0b",
    current: 295.00, min: 270.00, max: 310.00, avg: 292.80, shipping: 5.99,
    url: "https://amazon.de/dp/B09Y2NDXGQ"
  }
];

export default function ProductPage() {
  // Troviamo il minimo storico assoluto tra tutti i mercati per la validazione
  const absoluteMin = Math.min(...marketsStats.map(m => m.min));
  const recommendedPrice = absoluteMin + 5; // Consigliamo di puntare quasi al minimo storico

  const [alertPrice, setAlertPrice] = useState<string>(recommendedPrice.toString());
  const [isSaved, setIsSaved] = useState<boolean>(false);

  const parsedAlertPrice = parseFloat(alertPrice) || 0;
  // Logica per il banner: se l'utente mette un prezzo inferiore del 5% rispetto al minimo storico di sempre
  const isPriceTooLow = parsedAlertPrice > 0 && parsedAlertPrice < (absoluteMin * 0.95);

  const handleSaveAlert = () => {
    console.log("Alert salvato per:", parsedAlertPrice);
    setIsSaved(true);
    // TODO: Invia API per salvare su DB
  };

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
              I prezzi mostrati su questa pagina sono <strong>Finali</strong>. Includono già l'adeguamento IVA per l'Italia e i costi di spedizione stimati. Il prezzo che vedi è quello che pagherai al checkout.
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
                  Questo prezzo è inferiore al minimo storico dell'ultimo anno ({absoluteMin}€). Potrebbe non essere mai raggiunto.
                </p>
              </div>
            )}
          </div>

          <button 
            onClick={handleSaveAlert}
            disabled={isSaved}
            className={`w-full py-4 rounded-xl font-bold text-lg flex justify-center items-center gap-2 transition-all shadow-lg ${
              isSaved 
              ? "bg-gray-700 text-gray-300 cursor-not-allowed" 
              : "bg-[#2b8a3e] hover:bg-[#227031] text-white hover:shadow-green-900/20"
            }`}
          >
            {isSaved ? <><CheckCircle2 /> Alert Attivo</> : "Attiva Alert"}
          </button>
        </div>
      </div>

      {/* STATISTICHE MERCATI E BOTTONI AMAZON */}
      <h3 className="text-xl font-bold text-white mb-4">Dettagli per Mercato</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {marketsStats.map((market) => (
          <div key={market.code} className="bg-white rounded-3xl p-6 flex flex-col shadow-sm border border-gray-100 relative overflow-hidden">
            
            {/* Riga Colorata in cima alla card */}
            <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: market.color }} />

            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-2 text-xl font-bold text-gray-900">
                {market.flag} {market.name}
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase font-bold text-gray-400">Prezzo Attuale</div>
                <div className="text-2xl font-black text-gray-900">{market.current.toFixed(2)}€</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-6 bg-gray-50 p-3 rounded-xl border border-gray-100">
              <div className="text-center">
                <div className="text-xs text-gray-500 mb-1">Minimo</div>
                <div className="font-bold text-gray-800 flex justify-center items-center gap-1">
                  <TrendingDown size={14} className="text-green-600" /> {market.min.toFixed(2)}€
                </div>
              </div>
              <div className="text-center border-l border-r border-gray-200">
                <div className="text-xs text-gray-500 mb-1">Medio</div>
                <div className="font-bold text-gray-800">{market.avg.toFixed(2)}€</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500 mb-1">Massimo</div>
                <div className="font-bold text-gray-800 flex justify-center items-center gap-1">
                  <TrendingUp size={14} className="text-red-500" /> {market.max.toFixed(2)}€
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center text-sm mb-6 pb-4 border-b border-gray-100">
              <span className="text-gray-500">Costo spedizione calcolato:</span>
              <span className="font-mono font-semibold text-gray-700">
                {market.shipping === 0 ? "Gratuita" : `+${market.shipping.toFixed(2)}€`}
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