import { ApiAdapter, Task, NormalizedProduct } from "../types";

export class RealTimeAmazonDataAdapter implements ApiAdapter {
    public buildRequestConfig(task: Task, apiKey: string) {
        // Mappiamo il mercato al codice paese (es. amazon.it -> IT)
        const countryCode = task.market.split('.').pop()?.toUpperCase() || "IT";

        // --- INIZIO DEBUG ---
        const currentTime = new Date();
        console.log(`\n[RapidAPI] 🚀 Avvio Task -> ASIN: ${task.asin} | Mercato: ${task.market} | Orario esecuzione: ${currentTime.toLocaleTimeString('it-IT')}`);
        if (task.targetSlotTime) {
            console.log(`[RapidAPI] 🕒 (Slot originariamente pianificato per: ${new Date(task.targetSlotTime).toLocaleTimeString('it-IT')})`);
        }
        // --- FINE DEBUG ---

        return {
            url: "https://real-time-amazon-data.p.rapidapi.com/product-offers",
            method: "GET",
            headers: {
                "x-rapidapi-key": apiKey,
                "x-rapidapi-host": "real-time-amazon-data.p.rapidapi.com"
            },
            params: {
                asin: task.asin,
                country: countryCode,
                product_condition: "NEW",
                limit: 100,
                page: 1,
                fields: "asin,product_price,delivery_price,product_photo" // Aggiunto product_photo
            }
        };
    }

    public extractData(rawResponse: any): NormalizedProduct {
        const data = rawResponse?.data || {};
        const parameters = rawResponse?.parameters || {};
        const market = taskMarketFromCountry(parameters.country);

        const requestedAsin = parameters.asin || "UNKNOWN";
        const scrapedAsin = data.asin;

        // 1. Controllo Mismatch ASIN / Soft-Redirect
        if (scrapedAsin && requestedAsin !== "UNKNOWN" && scrapedAsin.toUpperCase() !== requestedAsin.toUpperCase()) {
            console.warn(`[RapidAPI] ⚠️ Mismatch ASIN rilevato: richiesto ${requestedAsin}, ottenuto ${scrapedAsin}.`);
            return {
                asin: requestedAsin,
                market,
                price: null,
                shippingCost: 0,
                currency: "EUR",
                title: undefined,
                imageUrl: undefined
            } as any;
        }

        const title = data.product_title || undefined;
        // Estrazione dell'immagine da product_photo
        const imageUrl = data.product_photo || undefined;

        // Estrazione Prezzo Principale o dalla prima offerta
        const rawPriceStr = data.product_price || (data.product_offers?.[0]?.product_price);
        const parsedPrice = parseItalianPrice(rawPriceStr);

        // 2. Controllo Prodotto non disponibile o senza prezzo
        if (parsedPrice === null) {
            console.log(`[RapidAPI] ❌ Prodotto non disponibile o senza prezzo (ASIN: ${requestedAsin})`);
            return {
                asin: requestedAsin,
                market,
                price: null,
                shippingCost: 0,
                currency: "EUR",
                title,
                imageUrl
            } as any;
        }

        // 3. Calcolo Spese di Spedizione
        const rawDeliveryStr = (data.delivery_price || data.product_offers?.[0]?.delivery_price || "").toLowerCase();
        const freeShippingKeywords = ['gratuita', 'gratis', 'inclusa', 'gratuit', 'free'];
        
        const isFreeShipping = freeShippingKeywords.some(kw => rawDeliveryStr.includes(kw));
        let shippingCost = 0.0;

        if (!isFreeShipping && rawDeliveryStr) {
            const extractedShipping = parseItalianPrice(rawDeliveryStr);
            if (extractedShipping !== null) {
                shippingCost = extractedShipping;
            }
        }

        console.log(`[RapidAPI] ✅ Dati estratti con successo (ASIN: ${requestedAsin} | Prezzo: ${parsedPrice}€)`);

        return {
            asin: requestedAsin,
            market,
            price: parsedPrice,
            shippingCost,
            currency: "EUR",
            title,
            imageUrl
        };
    }
}

/**
 * Utility per convertire stringhe di prezzo in formato Italiano in number.
 */
function parseItalianPrice(val?: string | null): number | null {
    if (!val) return null;

    const cleaned = val.replace(/[^0-9.,]/g, '').trim();
    if (!cleaned) return null;

    const standardFormat = cleaned.replace(/\./g, '').replace(',', '.');
    const parsed = parseFloat(standardFormat);

    return isNaN(parsed) ? null : parsed;
}

/**
 * Mappa il codice paese della risposta al dominio di Amazon.
 */
function taskMarketFromCountry(country?: string): string {
    if (!country) return "amazon.it";
    return `amazon.${country.toLowerCase()}`;
}