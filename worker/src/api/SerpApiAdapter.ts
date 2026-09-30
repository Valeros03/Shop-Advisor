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
                shipping_location: "it", // Attenzione: potresti volerlo adattare al mercato
                api_key: apiKey,
                no_cache: true
            }
        };
    }

    public extractData(rawResponse: any): NormalizedProduct {
        const product = rawResponse.product_results || {};
        const market = rawResponse.search_parameters?.amazon_domain || "amazon.it";
        const asin = rawResponse.search_parameters?.asin || "UNKNOWN";

        if (product.extracted_price === undefined || product.extracted_price === null) {
            return { asin, market, price: null, shippingCost: null, currency: "EUR" };
        }
        
        let shipping = 0.0;
        const deliveryText = (product.delivery ? product.delivery[0] : "").toLowerCase();
        
        // Dizionario Trilingue Infallibile
        const freeShippingKeywords = [
            'gratuita', 'gratis', 'senza costi aggiuntivi', 'inclusa',
            'gratuit', 'gratuite', 'sans frais', 'inclus', 'offerte', 'livraison gratuite',
            'kostenlose', 'kostenlos', 'kostenfreier', 'kostenfrei', 'ohne zusätzliche kosten'
        ];

        const isFreeShipping = freeShippingKeywords.some(kw => deliveryText.includes(kw));

        if (!isFreeShipping && deliveryText) {
            // Estrazione universale europea valute
            const match = deliveryText.match(/(?:€|eur)?\s*(\d+[,.]\d+)\s*(?:€|eur)?/i);
            if (match) {
                shipping = parseFloat(match[1].replace(",", "."));
            } else if (market === "amazon.fr") {
                shipping = 6.25; // Fallback d'emergenza specifico FR se regex fallisce su stringhe anomale
            }
        }

        return {
            asin,
            market,
            price: product.extracted_price,
            shippingCost: shipping,
            currency: "EUR"
        };
    }
}