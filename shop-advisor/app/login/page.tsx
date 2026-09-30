import Image from "next/image";
import TelegramLogin from "../components/TelegramLogin";

export default function LoginPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center bg-gray-50 text-gray-900 overflow-hidden">
      
      {/* Sfondo: Logo ingrandito, semitrasparente e sfocato */}
      <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none opacity-10 blur-[2px]">
        <Image 
          src="/logo.png" 
          alt="Sfondo Shop Advisor" 
          fill
          className="object-contain p-8"
          priority
        />
      </div>

      {/* Pannello Centrale: Glassmorphism con top verde */}
      <div className="relative z-10 max-w-md w-full bg-white/80 backdrop-blur-xl p-10 rounded-2xl shadow-xl border-t-4 border-[#2b8a3e] text-center">
        
        <h1 className="text-3xl font-extrabold mb-3 text-gray-800 tracking-tight">
          ShopAdvisor
        </h1>
        <p className="text-gray-500 mb-8 text-sm px-2">
          Il tuo carrello, intelligente. Accedi per monitorare i prezzi e ricevere notifiche istantanee.
        </p>
        
        {/* 
          Contenitore Widget: 
          La proprietà colorScheme: 'light' blocca le forzature della Dark Mode del browser,
          eliminando il rettangolo nero dietro il pulsante di Telegram.
        */}
        <div 
          className="relative z-20 flex justify-center items-center py-2" 
          style={{ colorScheme: 'light' }}
        >
           <TelegramLogin />
        </div>
        
        <p className="mt-8 text-xs text-gray-400 px-2 leading-relaxed">
          L'accesso serve esclusivamente per collegare il tuo account al bot. 
          Non condivideremo mai i tuoi dati personali.
        </p>
      </div>
    </div>
  );
}