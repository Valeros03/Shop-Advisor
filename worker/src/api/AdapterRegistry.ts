import { ApiAdapter } from '../types';
import { SerpApiAdapter } from './SerpApiAdapter';
// import { RainforestAdapter } from './RainforestAdapter';

export const AdapterRegistry: Record<string, new () => ApiAdapter> = {
    "SerpApiAdapter": SerpApiAdapter,
    // "RainforestAdapter": RainforestAdapter, // Quando lo aggiungerai, basterà scommentarlo qui
};