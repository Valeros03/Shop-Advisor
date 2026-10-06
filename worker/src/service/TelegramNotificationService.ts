// src/service/TelegramNotificationService.ts
import axios from "axios";

export interface QualifyingMarket {
    market: string;
    price: number;
    isPrimeExclusive?: boolean;
}

export interface UnifiedPriceAlertPayload {
    telegramId: string;
    productName: string;
    asin: string;
    targetPrice: number;
    bestPrice: number;
    bestMarket: string;
    qualifyingMarkets: QualifyingMarket[];
    imageUrl?: string;
    isPrimeExclusive?: boolean;
}

export type SendAlertResult = "SENT" | "BLOCKED" | "FAILED";

export class TelegramNotificationService {
    private botToken: string;
    private baseUrl: string;

    private readonly marketLabels: Record<string, string> = {
        "amazon.it": "🇮🇹 Amazon Italia",
        "amazon.fr": "🇫🇷 Amazon Francia",
        "amazon.de": "🇩🇪 Amazon Germania"
    };

    constructor() {
        this.botToken = process.env.TELEGRAM_BOT_TOKEN || "";
        this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;

        if (!this.botToken) {
            console.warn("[TelegramService] TELEGRAM_BOT_TOKEN non impostato. Le notifiche saranno simulate a terminale.");
        }
    }

    /**
     * Invia un alert unificato con le statistiche del miglior prezzo 
     * e l'elenco di tutti i mercati scesi sotto la soglia desiderata.
     */
    public async sendPriceAlert(payload: UnifiedPriceAlertPayload): Promise<SendAlertResult> {
        if (!this.botToken) {
            console.log(`[TelegramService] Notifica simulata a ${payload.telegramId}`);
            return "SENT";
        }

        const bestMarketName = this.marketLabels[payload.bestMarket] || payload.bestMarket;
        const totalSaved = (payload.targetPrice - payload.bestPrice).toFixed(2);

        let marketsDetailsText = "";
        const inlineKeyboardButtons: { text: string; url: string }[][] = [];
        let hasAnyPrimeOffer = false;

        for (const item of payload.qualifyingMarkets) {
            const label = this.marketLabels[item.market] || item.market;
            const diff = (payload.targetPrice - item.price).toFixed(2);
            const url = `https://www.${item.market}/dp/${payload.asin}`;
            const isAbsoluteBest = item.market === payload.bestMarket;
            const isPrime = Boolean(item.isPrimeExclusive);

            if (isPrime) {
                hasAnyPrimeOffer = true;
            }

            const primeTag = isPrime ? " 👑 <i>(Esclusiva Prime)</i>" : "";
            const bestTag = isAbsoluteBest ? " 🏆 <b>MIGLIORE</b>" : "";

            marketsDetailsText += `- <b>${label}</b>: <b>${item.price.toFixed(2)}€</b> (Risparmi: <i>${diff}€</i>)${primeTag}${bestTag}\n`;

            inlineKeyboardButtons.push([
                {
                    text: `${isPrime ? "👑 " : ""}Acquista su ${label} (${item.price.toFixed(2)}€)`,
                    url: url
                }
            ]);
        }

        const primeDisclaimer = hasAnyPrimeOffer 
            ? `\n👑 <i>Le offerte contrassegnate sono esclusive per i membri Amazon Prime del rispettivo paese (attivabili anche tramite i 30 giorni di prova gratuita).</i>\n` 
            : "";

        const messageText = 
            `🔔 <b>PREZZO TARGET RAGGIUNTO!</b>\n\n` +
            `📦 <b>${payload.productName}</b>\n` +
            `🏷️ ASIN: <code>${payload.asin}</code>\n\n` +
            `🎯 Tuo Prezzo Target: <b>${payload.targetPrice.toFixed(2)}€</b>\n` +
            `🔥 Minimo Raggiunto: <b>${payload.bestPrice.toFixed(2)}€</b> (${bestMarketName})${payload.isPrimeExclusive ? " 👑" : ""}\n` +
            `📉 Risparmio Massimo: <b>${totalSaved}€</b>\n\n` +
            `📋 <b>Mercati sotto soglia disponibili:</b>\n` +
            `${marketsDetailsText}` +
            `${primeDisclaimer}\n` +
            `<i>I prezzi visualizzati includono già l'adeguamento IVA per l'Italia e la spedizione standard.</i>`;

        try {
            if (payload.imageUrl && payload.imageUrl.startsWith("http")) {
                await axios.post(`${this.baseUrl}/sendPhoto`, {
                    chat_id: payload.telegramId,
                    photo: payload.imageUrl,
                    caption: messageText,
                    parse_mode: "HTML",
                    reply_markup: { inline_keyboard: inlineKeyboardButtons }
                });
            } else {
                await axios.post(`${this.baseUrl}/sendMessage`, {
                    chat_id: payload.telegramId,
                    text: messageText,
                    parse_mode: "HTML",
                    disable_web_page_preview: false,
                    reply_markup: { inline_keyboard: inlineKeyboardButtons }
                });
            }

            console.log(`[TelegramService] Alert inviato con successo a ${payload.telegramId}`);
            return "SENT";
        } catch (error: any) {
            const status = error.response?.status;
            const description = error.response?.data?.description || error.message;

            // Telegram restituisce 403 quando l'utente ha bloccato il bot o cancellato la chat
            if (status === 403 || (description && description.toLowerCase().includes("blocked"))) {
                console.warn(`[TelegramService] Utente ${payload.telegramId} ha bloccato il bot. Disattivazione richiesta.`);
                return "BLOCKED";
            }

            console.error(`[TelegramService] Errore invio alert a ${payload.telegramId}:`, description);
            return "FAILED";
        }
    }
}

export const telegramNotifier = new TelegramNotificationService();