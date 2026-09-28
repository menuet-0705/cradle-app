import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** メール送信。テストではこのトークンを差し替える */
export const MAILER = Symbol('MAILER');

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** SMTP で送る。ローカルは Mailpit、本番は Resend（違いは SMTP_URL だけ） */
@Injectable()
export class SmtpMailer implements Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private transporter?: Transporter;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: MailMessage): Promise<void> {
    const mail = this.config.mail;
    if (!mail) throw new ServiceUnavailableException('Mail is not configured');
    this.transporter ??= createTransport(smtpOptions(mail.smtpUrl));
    try {
      await this.transporter.sendMail({ from: mail.from, ...message });
    } catch (e) {
      // 宛先や本文はログに出さない
      this.logger.error(`Failed to send mail: ${(e as Error).name}`);
      throw new ServiceUnavailableException('Failed to send mail');
    }
  }
}

/** smtp(s)://user:pass@host:port を nodemailer の設定にする */
function smtpOptions(smtpUrl: string) {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 25),
    secure,
    auth: url.username
      ? {
          user: decodeURIComponent(url.username),
          pass: decodeURIComponent(url.password),
        }
      : undefined,
    // 応答しない SMTP でリクエスト（Vercel の制限時間）を使い切らないようにする
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 8_000,
  };
}
