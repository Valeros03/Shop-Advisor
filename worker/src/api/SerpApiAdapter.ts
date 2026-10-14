import { ApiAdapter, Task, NormalizedProduct } from "../types";

export class SerpApiAdapter implements ApiAdapter {
    public buildRequestConfig(task: Task, apiKey: string) {
        return {
            url: "https://serpapi.com/search",
            method: "GET",
            params: {
                engine: "amazon_product",
                asin: task.asin,
                amazon_domain: task.market,
                shipping_location: "it",
                api_key: apiKey,
                no_cache: true
            }
        };
    }

    public extractData(rawResponse: any): NormalizedProduct {
        const product = rawResponse.product_results || {};
        const market = rawResponse.search_parameters?.amazon_domain || "amazon.it";
        
        // L'ASIN che hai richiesto all'API
        const requestedAsin = rawResponse.search_parameters?.asin || "UNKNOWN";
        
        // L'ASIN che SerpApi ha effettivamente trovato ed estratto dalla pagina
        const scrapedAsin = product.asin; 

        // 1. Controllo Anti Soft-Redirect
        if (scrapedAsin && requestedAsin !== "UNKNOWN" && scrapedAsin.toUpperCase() !== requestedAsin.toUpperCase()) {
            console.warn(`[SerpApi] Mismatch ASIN rilevato: richiesto ${requestedAsin}, ottenuto ${scrapedAsin}.`);
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

        const title = product.title || undefined;
        const imageUrl = product.main_image || (product.images && product.images.length > 0 ? product.images[0] : undefined);

        // 2. Controllo Prodotto non disponibile o senza prezzo
        if (product.extracted_price === undefined || product.extracted_price === null) {
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

        let shipping = 0.0;
        const deliveryText = (product.delivery ? product.delivery[0] : "").toLowerCase();

        // Dizionario Trilingue
        const freeShippingKeywords = [
            'gratuita', 'gratis', 'senza costi aggiuntivi', 'inclusa',
            'gratuit', 'gratuite', 'sans frais', 'inclus', 'offerte', 'livraison gratuite',
            'kostenlose', 'kostenlos', 'kostenfreier', 'kostenfrei', 'ohne zusätzliche kosten'
        ];

        const isFreeShipping = freeShippingKeywords.some(kw => deliveryText.includes(kw));

        if (!isFreeShipping && deliveryText) {
            const match = deliveryText.match(/(?:€|eur)?\s*(\d+[,.]\d+)\s*(?:€|eur)?/i);
            if (match) {
                shipping = parseFloat(match[1].replace(",", "."));
            } else if (market === "amazon.fr") {
                shipping = 6.25;
            }
        }

        return {
            asin: requestedAsin, // Restituiamo sempre quello richiesto per non corrompere il DB
            market,
            price: product.extracted_price,
            shippingCost: shipping,
            currency: "EUR",
            title,
            imageUrl
        };
    }
}