import { ServiceUnavailableException } from '@nestjs/common';
import { loadConfig } from '../config/env.js';
import {
  MailDeliveryUnknownError,
  ResendMailer,
  SmtpMailer,
  createMailer,
} from './mailer.js';

const message = {
  to: 'papa@example.com',
  subject: 's',
  text: 't',
  html: '<p>h</p>',
};

/** Resend の SDK の代わり。send の引数を記録し、指定した動きをする */
const fakeClient = (
  send: (
    payload: unknown,
    options: { signal: AbortSignal },
  ) => Promise<unknown>,
) => ({ emails: { send } }) as never;

describe('ResendMailer', () => {
  it('sends only the expected fields with the configured sender', async () => {
    const sent: unknown[] = [];
    const mailer = new ResendMailer(
      'すくすく記録 <no-reply@example.com>',
      fakeClient((payload) => {
        sent.push(payload);
        return Promise.resolve({ data: { id: 'e1' }, error: null });
      }),
    );
    // 型に無い項目（bcc など）を混ぜても送らない
    await mailer.send({ ...message, bcc: 'x@example.com' } as never);
    expect(sent).toEqual([
      { from: 'すくすく記録 <no-reply@example.com>', ...message },
    ]);
  });

  it('turns SDK errors (returned, not thrown) into 503', async () => {
    const mailer = new ResendMailer(
      'a <a@example.com>',
      fakeClient(() =>
        Promise.resolve({
          data: null,
          error: { name: 'validation_error', message: 'x', statusCode: 422 },
        }),
      ),
    );
    const error = await mailer.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error).not.toBeInstanceOf(MailDeliveryUnknownError);
  });

  it('turns thrown errors into 503', async () => {
    const mailer = new ResendMailer(
      'a <a@example.com>',
      fakeClient(() => Promise.reject(new TypeError('bad header'))),
    );
    await expect(mailer.send(message)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('aborts the request on timeout and reports the delivery as unknown', async () => {
    let aborted = false;
    const mailer = new ResendMailer(
      'a <a@example.com>',
      // SDK と同じく、通信の失敗（打ち切り）は例外ではなく { error } で返す
      fakeClient(
        (_payload, { signal }) =>
          new Promise((resolve) =>
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve({
                data: null,
                error: { name: 'application_error', message: 'aborted' },
              });
            }),
          ),
      ),
      20,
    );
    await expect(mailer.send(message)).rejects.toBeInstanceOf(
      MailDeliveryUnknownError,
    );
    expect(aborted).toBe(true);
  });
});

describe('createMailer', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(48),
    EMAIL_FROM: 'a <a@example.com>',
    APP_URL: 'http://localhost:8080',
  };

  it('picks Resend in production and SMTP locally', () => {
    expect(
      createMailer(loadConfig({ ...base, RESEND_API_KEY: 're_abcdefgh123' })),
    ).toBeInstanceOf(ResendMailer);
    expect(
      createMailer(loadConfig({ ...base, SMTP_URL: 'smtp://localhost:1025' })),
    ).toBeInstanceOf(SmtpMailer);
  });

  it('fails with 503 when mail is not configured', async () => {
    const mailer = createMailer(
      loadConfig({
        DATABASE_URL: base.DATABASE_URL,
        JWT_ACCESS_SECRET: base.JWT_ACCESS_SECRET,
      }),
    );
    await expect(mailer.send(message)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
