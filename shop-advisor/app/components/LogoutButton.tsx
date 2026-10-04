"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Loader2 } from "lucide-react";

export default function LogoutButton() {
  const router = useRouter();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (isLoggingOut) return;

    try {
      setIsLoggingOut(true);

      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        // Forza il refresh del router e reindirizza alla pagina di login
        router.refresh();
        window.location.href = "/login";
      } else {
        alert("Errore durante la disconnessione.");
      }
    } catch (err) {
      console.error("Errore di rete durante il logout:", err);
      // Fallback: reindirizza comunque alla pagina di login
      window.location.href = "/login";
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <button
      onClick={handleLogout}
      disabled={isLoggingOut}
      className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-gray-700 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors disabled:opacity-50"
      title="Disconnettiti"
    >
      {isLoggingOut ? (
        <Loader2 className="w-4 h-4 animate-spin text-red-600" />
      ) : (
        <LogOut className="w-4 h-4" />
      )}
      <span>Esci</span>
    </button>
  );
}