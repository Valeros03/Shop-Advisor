// types.ts

export type AmazonMarket = "amazon.it" | "amazon.fr" | "amazon.de";

export interface PriceSnapshot {
    price: number;
    shipping: number;
    timestamp: string; // Formato ISO 8601
}

export interface Task {
    asin: string;
    market: AmazonMarket;
    isMustTomorrow: boolean;
    cycleIndex: number;         // 0 per il 1° update, 1 per il 2°, ecc.
    targetSlotTime?: number;    // Timestamp indicativo calcolato dal Dispatcher
}

export interface NormalizedProduct {
    asin: string;
    market: AmazonMarket;
    price: number | null;
    shippingCost: number | null;
    currency: string;
}

export interface WorkerResult {
    success: boolean;
    data?: NormalizedProduct;
    error?: string;
    timestamp: Date;
}

export interface WorkerLimits {
    dailyLimit: number;
    monthlyLimit: number;
    lifetimeLimit: number;
    rateLimitTps: number | null;
}

export interface ApiAdapter {
    buildRequestConfig(task: Task, apiKey: string): any;
    extractData(rawResponse: any): NormalizedProduct;
}

export interface ProductRecord {
    id: string;
    asin: string;
    priorityCode: number;
    mustTomorrow: boolean;
    lastUpdated: Date;
}