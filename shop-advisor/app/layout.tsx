// app/layout.tsx
import type { Metadata } from "next";
import Navbar from "@/app/components/Navbar";
import "./globals.css"; 

export const metadata: Metadata = {
  title: "ShopAdvisor",
  description: "Traccia i prezzi Amazon su IT, FR e DE",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body className="bg-gray-50 min-h-screen text-gray-900 font-sans">
        <Navbar />
        {children}
      </body>
    </html>
  );
}