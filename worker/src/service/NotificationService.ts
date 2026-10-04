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
                secure: port === 465, // true per SSL su porta 465
                auth: { user, pass }
            });
            this.isConfigured = true;
        } else {
            console.warn("[NotificationService] Credenziali SMTP non configurate. Le notifiche saranno registrate solo a terminale.");
        }
    }

    /**
     * Invia un alert email con supporto ad allegati opzionali (es. file diagnostico XML).
     */
    public async sendAlert(subject: string, message: string, attachmentPath?: string): Promise<void> {
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
                <p style="font-size: 11px; color: #999; margin: 0;">Inviato automaticamente dal servizio Worker ShopAdvisor.</p>
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