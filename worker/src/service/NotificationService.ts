import * as dotenv from "dotenv";
dotenv.config();

import * as nodemailer from "nodemailer";
import * as path from "path";
import * as fs from "fs";

export class NotificationService {
    private transporter: nodemailer.Transporter | null = null;
    private fromEmail: string;
    private toEmail: string;
    private isConfigured: boolean = false;

    // Cache di deduplicazione: mappa chiave -> timestamp invio
    private sentAlertsToday: Map<string, number> = new Map();
    private lastResetDay: number = new Date().getDate();

    constructor() {
        const host = process.env.SMTP_HOST || "smtp.gmail.com";
        const port = parseInt(process.env.SMTP_PORT || "465", 10);
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;

        this.fromEmail = process.env.SMTP_FROM || user || "alerts@shopadvisor.local";
        this.toEmail = process.env.SMTP_TO || this.fromEmail;

        if (user && pass && user !== "tuaemail@gmail.com") {
            this.transporter = nodemailer.createTransport({
                host,
                port,
                secure: port === 465,
                auth: { user, pass }
            });
            this.isConfigured = true;
        } else {
            console.warn("[NotificationService] Credenziali SMTP non configurate. Le notifiche saranno registrate solo a terminale.");
        }
    }

    /**
     * Resetta la cache degli alert se siamo passati a un nuovo giorno di calendario.
     */
    private checkAndResetDailyCache(): void {
        const currentDay = new Date().getDate();
        if (currentDay !== this.lastResetDay) {
            this.sentAlertsToday.clear();
            this.lastResetDay = currentDay;
            console.log("[NotificationService] Reset giornaliero della cache di deduplicazione completato.");
        }
    }

    /**
     * Calcola una chiave univoca per identificare l'errore.
     * Isola l'ASIN e il market per evitare falsi positivi tra prodotti diversi.
     */
    private createDeduplicationKey(subject: string, message: string): string {
        const content = `${subject} ${message}`;

        // Cerca pattern standard ASIN (10 caratteri alfanumerici)
        const asinMatch = content.match(/\b([B0-9][A-Z0-9]{9})\b/i);
        const asin = asinMatch ? asinMatch[1].toUpperCase() : null;

        // Cerca eventuale marketplace menzionato
        const marketMatch = content.match(/amazon\.(it|fr|de)/i);
        const market = marketMatch ? marketMatch[0].toLowerCase() : null;

        // Normalizza il subject rimuovendo contatori tipo "(Fallimento #1)", date o timestamp
        const normalizedSubject = subject
            .replace(/\(Fallimento #\d+\)/gi, "")
            .replace(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/g, "")
            .trim();

        if (asin && market) {
            return `${normalizedSubject}::ASIN_${asin}::MKT_${market}`;
        }
        if (asin) {
            return `${normalizedSubject}::ASIN_${asin}`;
        }

        // Errore generico non legato a un prodotto specifico
        return `${normalizedSubject}::GENERIC`;
    }

    /**
     * Invia un alert email con supporto ad allegati e deduplicazione giornaliera.
     */
    public async sendAlert(subject: string, message: string, attachmentPath?: string): Promise<void> {
        this.checkAndResetDailyCache();

        const dedupKey = this.createDeduplicationKey(subject, message);

        if (this.sentAlertsToday.has(dedupKey)) {
            const firstSentTimestamp = new Date(this.sentAlertsToday.get(dedupKey)!).toLocaleTimeString('it-IT');
            return;
        }

        // Registra l'avvenuto invio prima di procedere
        this.sentAlertsToday.set(dedupKey, Date.now());

        if (!this.isConfigured || !this.transporter) {
            console.log(`[NotificationService] [DRY RUN] Alert: ${subject}`);
            console.log(`[NotificationService] [DRY RUN] Testo: ${message}`);
            if (attachmentPath) console.log(`[NotificationService] [DRY RUN] Allegato: ${attachmentPath}`);
            return;
        }

        const mailAttachments: nodemailer.SendMailOptions["attachments"] = [];

        if (attachmentPath && fs.existsSync(attachmentPath)) {
            mailAttachments.push({
                filename: path.basename(attachmentPath),
                path: attachmentPath,
                contentType: "application/xml"
            });
        }

        const htmlBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
                <h2 style="color: #d32f2f; margin-top: 0;">🚨 Alert ShopAdvisor Worker</h2>
                <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #d32f2f; margin-bottom: 20px;">
                    <strong style="display: block; font-size: 16px; margin-bottom: 8px;">${subject}</strong>
                    <pre style="white-space: pre-wrap; font-family: monospace; font-size: 13px; color: #333;">${message}</pre>
                </div>
                ${attachmentPath ? `<p style="font-size: 12px; color: #666;">📎 In allegato trovi l'ispezione diagnostica XML completa del DOM analizzato.</p>` : ""}
                <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
                <p style="font-size: 11px; color: #999; margin: 0;">Inviato automaticamente dal servizio Worker ShopAdvisor. Eventuali repliche di questo errore per lo stesso contesto saranno soppresse fino a domani.</p>
            </div>
        `;

        try {
            await this.transporter.sendMail({
                from: `"ShopAdvisor Monitor" <${this.fromEmail}>`,
                to: this.toEmail,
                subject: `${subject}`,
                text: message,
                html: htmlBody,
                attachments: mailAttachments
            });
            console.log(`[NotificationService] Email inviata con successo: ${subject}`);
        } catch (err: any) {
            console.error(`[NotificationService] Errore durante l'invio dell'email:`, err.message);
        }
    }
}

export const notifier = new NotificationService();