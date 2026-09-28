import { Global, Module } from '@nestjs/common';
import { MAILER, SmtpMailer } from './mailer.js';

@Global()
@Module({
  providers: [{ provide: MAILER, useClass: SmtpMailer }],
  exports: [MAILER],
})
export class MailModule {}
