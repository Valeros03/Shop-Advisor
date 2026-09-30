"use client";

import { useEffect, useRef } from "react";

export default function TelegramLogin() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 1. Definiamo la variabile container agganciandola al div
    const container = containerRef.current;
    
    // 2. Se il div non è ancora renderizzato, ci fermiamo
    if (!container) return;

    // 3. Prevenzione del doppio caricamento (React Strict Mode)
    if (container.querySelector("script")) return;

    // Sostituisci la vecchia (window as any).onTelegramAuth con questa:
    (window as any).onTelegramAuth = async (user: any) => {
    try {
        const response = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user),
        });

        if (response.ok) {
        // Login confermato dal backend, reindirizziamo alla dashboard!
        window.location.href = '/dashboard';
        } else {
        alert("Errore durante la validazione dell'accesso.");
        }
    } catch (error) {
        console.error("Errore di rete:", error);
    }
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    
    // INSERISCI QUI IL TUO NOME BOT VERO (Senza @)
    script.setAttribute("data-telegram-login", "ValerosShop_Advisor_bot"); 
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.async = true;

    // 4. Ora container è definito e possiamo iniettarci lo script
    container.appendChild(script);
  }, []);

  return (
    <div 
      ref={containerRef} 
      id="telegram-container" 
      className="flex justify-center min-h-[50px]"
    ></div>
  );
}