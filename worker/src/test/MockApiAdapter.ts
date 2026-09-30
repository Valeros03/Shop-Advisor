import { ApiAdapter, Task, NormalizedProduct } from "../types";

export class MockApiAdapter implements ApiAdapter {
    public buildRequestConfig(task: Task, apiKey: string) {
        return {
            url: "https://mock.api/search",
            method: "GET",
            params: { asin: task.asin, market: task.market }
        };
    }

    public extractData(rawResponse: any): NormalizedProduct {
        // Random price between 10 and 100
        const price = Math.round((Math.random() * 90 + 10) * 100) / 100;
        // Random shipping between 0 and 10 (or free)
        const shippingCost = Math.random() > 0.5 ? 0 : Math.round((Math.random() * 10) * 100) / 100;

        return {
            asin: rawResponse.asin || "TEST_ASIN",
            market: rawResponse.market || "amazon.it",
            price,
            shippingCost,
            currency: "EUR"
        };
    }
}
