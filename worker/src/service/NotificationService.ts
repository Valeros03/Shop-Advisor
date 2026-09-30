// NotificationService.ts
import * as nodemailer from 'nodemailer';

export class NotificationService {
    private transporter = nodemailer.createTransport({
        service: 'gmail', // o il tuo SMTP (es. Sendinblue, AWS SES)
        auth: {
            user: 'tuaemail@gmail.com',
            pass: 'tua_password_per_app' 
        }
    });

    public async sendAlert(subject: string, message: string) {
        try {
            await this.transporter.sendMail({
                from: '"Amazon Scraper Alert" <tuaemail@gmail.com>',
                to: 'tuaemail_destinazione@gmail.com',
                subject: `🚨 ${subject}`,
                text: message
            });
            console.log(`[Notifica] Email inviata: ${subject}`);
        } catch (err) {
            console.error(`[Notifica] Errore invio email:`, err);
        }
    }
}

export const notifier = new NotificationService();