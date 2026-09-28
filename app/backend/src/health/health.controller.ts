import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/auth.decorators.js';

// 認証なしで叩けるので DB には触れない（接続の占有を防ぐ）。DB 疎通は各 API のエラーで分かる
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return { status: 'ok' };
  }
}
