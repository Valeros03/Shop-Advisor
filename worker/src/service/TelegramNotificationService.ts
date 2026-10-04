// src/service/TelegramNotificationService.ts
import axios from "axios";

export interface QualifyingMarket {
    market: string;
    price: number;
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
}

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
            console.warn("[TelegramService]TELEGRAM_BOT_TOKEN non impostato. Le notifiche saranno simulate a terminale.");
        }
    }

    /**
     * Invia un alert unificato con le statistiche del miglior prezzo 
     * e l'elenco di tutti i mercati scesi sotto la soglia desiderata.
     */
    public async sendPriceAlert(payload: UnifiedPriceAlertPayload): Promise<boolean> {
        if (!this.botToken) {
            console.log(`[TelegramService] [SIMULAZIONE] Notifica inviata a ${payload.telegramId} per ASIN ${payload.asin} (Miglior prezzo: ${payload.bestPrice}€)`);
            return true;
        }

        const bestMarketName = this.marketLabels[payload.bestMarket] || payload.bestMarket;
        const totalSaved = (payload.targetPrice - payload.bestPrice).toFixed(2);

        // Composizione della lista di tutti i mercati sotto soglia e dei relativi bottoni
        let marketsDetailsText = "";
        const inlineKeyboardButtons: { text: string; url: string }[][] = [];

        for (const item of payload.qualifyingMarkets) {
            const label = this.marketLabels[item.market] || item.market;
            const diff = (payload.targetPrice - item.price).toFixed(2);
            const url = `https://www.${item.market}/dp/${payload.asin}`;
            const isAbsoluteBest = item.market === payload.bestMarket;

            marketsDetailsText += `- <b>${label}</b>: <b>${item.price.toFixed(2)}€</b> (Risparmi: <i>${diff}€</i>)${isAbsoluteBest ? " 🏆 <b>MIGLIORE</b>" : ""}\n`;
            
            inlineKeyboardButtons.push([
                {
                    text: `Acquista su ${label} (${item.price.toFixed(2)}€)`,
                    url: url
                }
            ]);
        }

        const messageText = 
            `🔔 <b>PREZZO TARGET RAGGIUNTO!</b>\n\n` +
            `📦 <b>${payload.productName}</b>\n` +
            `🏷️ ASIN: <code>${payload.asin}</code>\n\n` +
            `🎯 Tuo Prezzo Target: <b>${payload.targetPrice.toFixed(2)}€</b>\n` +
            `🔥 Minimo Raggiunto: <b>${payload.bestPrice.toFixed(2)}€</b> (${bestMarketName})\n` +
            `📉 Risparmio Massimo: <b>${totalSaved}€</b>\n\n` +
            `📋 <b>Mercati sotto soglia disponibili:</b>\n` +
            `${marketsDetailsText}\n` +
            `<i>I prezzi visualizzati includono già l'adeguamento IVA per l'Italia e la spedizione standard.</i>`;

        try {
            // Se c'è un'immagine valida, invia con foto (sendPhoto), altrimenti messaggio testuale (sendMessage)
            if (payload.imageUrl && payload.imageUrl.startsWith("http")) {
                await axios.post(`${this.baseUrl}/sendPhoto`, {
                    chat_id: payload.telegramId,
                    photo: payload.imageUrl,
                    caption: messageText,
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: inlineKeyboardButtons
                    }
                });
            } else {
                await axios.post(`${this.baseUrl}/sendMessage`, {
                    chat_id: payload.telegramId,
                    text: messageText,
                    parse_mode: "HTML",
                    disable_web_page_preview: false,
                    reply_markup: {
                        inline_keyboard: inlineKeyboardButtons
                    }
                });
            }

            console.log(`[TelegramService] Alert inviato con successo a Telegram ID ${payload.telegramId} per ASIN ${payload.asin}`);
            return true;
        } catch (error: any) {
            const description = error.response?.data?.description || error.message;
            console.error(`[TelegramService] Errore durante l'invio dell'alert a ${payload.telegramId}:`, description);
            return false;
        }
    }
}

export const telegramNotifier = new TelegramNotificationService();