import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  CurrentUser,
  Public,
  type AuthUser,
} from '../common/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  loginSchema,
  refreshSchema,
  signupSchema,
  type LoginDto,
  type RefreshDto,
  type SignupDto,
} from './auth.dto.js';
import { AuthService } from './auth.service.js';

// 総当たり対策: 認証系は 1 分あたり 10 回まで
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('auth/signup')
  signup(@Body(new ZodValidationPipe(signupSchema)) dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('auth/login')
  login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('auth/refresh')
  refresh(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(204)
  @Post('auth/logout')
  async logout(@Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const found = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!found) throw new NotFoundException();
    return found;
  }
}
