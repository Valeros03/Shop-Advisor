import { ApiAdapter } from '../types';
import { SerpApiAdapter } from './SerpApiAdapter';
import { RealTimeAmazonDataAdapter } from './RealTimeAmazonDataAdapter';
// import { RainforestAdapter } from './RainforestAdapter';

export const AdapterRegistry: Record<string, new () => ApiAdapter> = {
    "SerpApiAdapter": SerpApiAdapter,
    "RealTimeAmazonDataAdapter": RealTimeAmazonDataAdapter,
};