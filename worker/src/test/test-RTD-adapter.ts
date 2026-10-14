import axios from 'axios';
import { RealTimeAmazonDataAdapter } from '../api/RealtimeAmazonAdapter'; // Modifica il path se necessario
import { Task } from '.../types';

async function runTest() {
    // 1. Inserisci qui la tua chiave RapidAPI oppure passala come variabile d'ambiente
    const apiKey = process.env.RAPIDAPI_KEY || "c029f16234msh6b63944114b1277p1241f0jsn5adaeae7789f";
    
    // ASIN da testare (da riga di comando o default)
    const asinToTest = process.argv[2] || "B0DSG52H7D"; 

    console.log("================================================");
    console.log(` 🧪 AVVIO TEST ADAPTER RAPIDAPI (Real-Time Amazon)`);
    console.log(` 📦 ASIN: ${asinToTest}`);
    console.log("================================================\n");

    const adapter = new RealTimeAmazonDataAdapter();

    // Mock del Task
    const mockTask: Task = {
        asin: asinToTest,
        market: "amazon.it"
    };

    // 2. Costruzione della configurazione
    const config = adapter.buildRequestConfig(mockTask, apiKey);
    console.log("1️⃣  Request Config generato:");
    console.log(JSON.stringify(config, null, 2));

    try {
        console.log("\n2️⃣  Invio chiamata HTTP a RapidAPI...");
        
        // Esecuzione chiamata HTTP reale
        const response = await axios({
            url: config.url,
            method: config.method,
            headers: config.headers,
            params: config.params
        });

        console.log("\n3️⃣  Risposta RAW ricevuta dall'API (Status:", response.status, "):");
        console.log(JSON.stringify(response.data, null, 2));

        // 3. Estrazione e Normalizzazione dati con l'Adapter
        const normalizedProduct = adapter.extractData(response.data);

        console.log("\n================================================");
        console.log(" 🟢 RISULTATO NORMALIZZATO (NormalizedProduct):");
        console.log("================================================");
        console.log(JSON.stringify(normalizedProduct, null, 2));

        // 4. Checklist di validazione
        console.log("\n📋 Checklist di controllo:");
        console.log("- ASIN corrispondente?:", normalizedProduct.asin === asinToTest ? "✅ SÌ" : "❌ NO (Mismatch)");
        console.log("- Prezzo estratto?:", normalizedProduct.price !== null ? `✅ ${normalizedProduct.price} €` : "❌ Non trovato / null");
        console.log("- Spese spedizione?:", `✅ ${normalizedProduct.shippingCost} €`);
        console.log("- Titolo presente?:", normalizedProduct.title ? `✅ ${normalizedProduct.title}` : "⚠️ Assente");
        console.log("- URL Immagine presente?:", normalizedProduct.imageUrl ? `✅ ${normalizedProduct.imageUrl}` : "⚠️ Assente");

    } catch (error: any) {
        console.error("\n❌ ERRORE DURANTE LA CHIAMATA:");
        if (error.response) {
            console.error(`HTTP Status: ${error.response.status}`);
            console.error("Payload Errore:", error.response.data);
        } else {
            console.error(error.message);
        }
    }
}

runTest();