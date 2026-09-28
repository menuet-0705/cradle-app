import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  CurrentUser,
  Public,
  type AuthUser,
} from '../common/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  loginSchema,
  refreshSchema,
  signupSchema,
  type LoginDto,
  type SignupDto,
} from './auth.dto.js';
import { AuthService, type AuthTokens } from './auth.service.js';
import {
  clearRefreshCookie,
  isCookieMode,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie.js';

// 総当たり対策: ログイン・登録は 1 分あたり 10 回まで
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };
// リフレッシュは推測不能な 256bit トークンが必要なので緩める（Web はページ読み込みのたびに呼ぶ）
const REFRESH_THROTTLE = { default: { limit: 60, ttl: 60_000 } };
// トークンを含む応答をキャッシュさせない
const NO_STORE = ['Cache-Control', 'no-store'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const refreshBodyPipe = new ZodValidationPipe(refreshSchema);

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @Post('auth/signup')
  async signup(
    @Body(new ZodValidationPipe(signupSchema)) dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(req, res, await this.auth.signup(dto));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Header(...NO_STORE)
  @HttpCode(200)
  @Post('auth/login')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(req, res, await this.auth.login(dto));
  }

  @Public()
  @Throttle(REFRESH_THROTTLE)
  @Header(...NO_STORE)
  @HttpCode(200)
  @Post('auth/refresh')
  async refresh(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, body);
    if (!token) throw new UnauthorizedException('Invalid refresh token');
    // 失敗時に Cookie は消さない（一時的なサーバーエラーや、他タブが更新済みの新しい Cookie を消さないため）
    return this.respond(req, res, await this.auth.refresh(token));
  }

  @Public()
  @Header(...NO_STORE)
  @HttpCode(204)
  @Post('auth/logout')
  async logout(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, body);
    if (isCookieMode(req)) clearRefreshCookie(res);
    if (token) await this.auth.logout(token);
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

  /** Web（Cookie モード）は Cookie から、モバイルは本文から取り出す */
  private refreshTokenFrom(req: Request, body: unknown): string | undefined {
    if (isCookieMode(req)) return readRefreshCookie(req);
    return refreshBodyPipe.transform(body).refreshToken;
  }

  /** Cookie モードではリフレッシュトークンを本文に含めず Cookie で渡す */
  private respond(req: Request, res: Response, tokens: AuthTokens) {
    if (!isCookieMode(req)) return tokens;
    setRefreshCookie(
      res,
      tokens.refreshToken,
      this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
    );
    const { refreshToken: _omit, ...rest } = tokens;
    return rest;
  }
}
