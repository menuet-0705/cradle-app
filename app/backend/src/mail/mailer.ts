import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import type { AppConfig } from '../config/env.js';

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

// 応答しない送信先でリクエスト（Vercel の制限時間）を使い切らないようにする
const SEND_TIMEOUT_MS = 8_000;
// 接続先は公式の API に固定する（RESEND_BASE_URL 環境変数の読み込みに任せない）
const RESEND_API_URL = 'https://api.resend.com';

const failed = () => new ServiceUnavailableException('Failed to send mail');

/**
 * 送信を待ちきれなかった（時間切れ）。送信先がその後に受け付けて届く可能性があるため、
 * 呼び出し側は「送れなかった」と決めつけず、送った前提のデータ（招待など）を残す
 */
export class MailDeliveryUnknownError extends ServiceUnavailableException {
  constructor() {
    super('Mail delivery status is unknown');
  }
}

/** Resend の API（公式 SDK）で送る。本番用 */
export class ResendMailer implements Mailer {
  private readonly logger = new Logger(ResendMailer.name);

  constructor(
    private readonly from: string,
    private readonly client: Pick<Resend, 'emails'>,
    private readonly timeoutMs = SEND_TIMEOUT_MS,
  ) {}

  static create(apiKey: string, from: string) {
    // 補足: SDK は NODE_ENV が production 以外のとき、送信エラーを console.error に出す
    // （宛先を含みうる）。Vercel は production、ローカルは SMTP を使うので実質出ない
    return new ResendMailer(
      from,
      new Resend(apiKey, { baseUrl: RESEND_API_URL }),
    );
  }

  async send(message: MailMessage): Promise<void> {
    // 時間切れで通信自体を打ち切る（SDK は第 2 引数をそのまま fetch に渡す。型定義にはないが signal も効く）
    const signal = AbortSignal.timeout(this.timeoutMs);
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.client.emails.send(
        // 項目を明示する（呼び出し側の値で差出人や宛先が上書き・追加されないように）
        {
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        { signal } as Parameters<Resend['emails']['send']>[1],
      );
    } catch (e) {
      // 宛先や本文はログに出さない（例外の内容には宛先が含まれうるので名前だけ）
      this.logger.error(`Failed to send mail: ${(e as Error).name}`);
      throw signal.aborted ? new MailDeliveryUnknownError() : failed();
    }
    // 打ち切りで失敗した場合、打ち切る前に Resend が受け付けていれば届く可能性がある
    // （期限ちょうどに成功の応答が届いたときは成功として扱う）
    if (signal.aborted && result.error) {
      this.logger.error('Mail send timed out');
      throw new MailDeliveryUnknownError();
    }
    // SDK は失敗時も例外ではなく { error } を返す
    if (result.error) {
      this.logger.error(`Failed to send mail: ${result.error.name}`);
      throw failed();
    }
  }
}

/** SMTP で送る。ローカルの Mailpit 用（外部には届かない） */
export class SmtpMailer implements Mailer {
  private readonly logger = new Logger(SmtpMailer.name);
  private readonly transporter: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transporter = createTransport(smtpOptions(url));
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (e) {
      // 宛先や本文はログに出さない
      this.logger.error(`Failed to send mail: ${(e as Error).name}`);
      throw failed();
    }
  }
}

/** メールが未設定のとき。呼ばれたら 503 */
class UnconfiguredMailer implements Mailer {
  send(): Promise<void> {
    return Promise.reject(
      new ServiceUnavailableException('Mail is not configured'),
    );
  }
}

/** 設定に応じた送信手段を作る（違いは環境変数だけ） */
export function createMailer(config: AppConfig): Mailer {
  const mail = config.mail;
  if (!mail) return new UnconfiguredMailer();
  return mail.transport.type === 'resend'
    ? ResendMailer.create(mail.transport.apiKey, mail.from)
    : new SmtpMailer(mail.transport.url, mail.from);
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
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: SEND_TIMEOUT_MS,
  };
}
