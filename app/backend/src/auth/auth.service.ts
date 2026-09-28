import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LoginDto, SignupDto } from './auth.dto.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 盗用検知を弱めすぎないよう、再送の猶予は短くする
const REUSE_GRACE_MS = 10 * 1000;

@Injectable()
export class AuthService {
  // 存在しないメールでも同じ時間をかけ、ユーザー存在を推測されないようにする
  private readonly dummyHash = hashPassword(randomBytes(16).toString('hex'));

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async signup(dto: SignupDto): Promise<AuthTokens> {
    const passwordHash = await hashPassword(dto.password);
    try {
      // 家族単位でデータを持つので、登録時に本人の家族も作る
      const user = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          name: dto.name,
          memberships: {
            create: {
              role: 'OWNER',
              family: { create: { name: `${dto.name}の家族` } },
            },
          },
        },
      });
      return this.issueTokens(user.id);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Email already registered');
      }
      throw e;
    }
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    const ok = await verifyPassword(
      dto.password,
      user?.passwordHash ?? (await this.dummyHash),
    );
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    return this.issueTokens(user.id);
  }

  /**
   * リフレッシュトークンはローテーションする。失効済みトークンの再利用は盗用とみなし全失効。
   * ただし失効直後（応答が届かず端末が再送した場合など）は全失効せず 401 のみ返す
   * （その端末は再ログインが必要。他の端末のセッションは維持される）。
   * 再送時に再発行する方式は盗用検知を弱めるため採用しない。
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt) {
      if (Date.now() - stored.revokedAt.getTime() > REUSE_GRACE_MS) {
        await this.revokeAll(stored.userId);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 旧トークンの失効と新トークンの発行は同時に成功/失敗させる。
    // 同時リクエストで二重に発行されないよう、未失効の場合のみ失効させる
    const tokens = await this.prisma.$transaction(
      async (tx) => {
        const { count } = await tx.refreshToken.updateMany({
          where: { id: stored.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return count === 0 ? null : this.issueTokens(stored.userId, tx);
      },
      // プール上限 1 で他のクエリと接続を取り合っても 500 にならないよう待ち時間を延ばす
      { maxWait: 5000, timeout: 5000 },
    );
    if (!tokens) {
      // 同一トークンの同時使用。正規の端末と盗用者の競合の可能性があるため全失効。
      // （トランザクション外で行う。プール上限 1 の環境で接続待ちにならないように）
      await this.revokeAll(stored.userId);
      throw new UnauthorizedException('Invalid refresh token');
    }
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: sha256(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async revokeAll(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync({ sub: userId });
    const refreshToken = randomBytes(32).toString('base64url');
    await db.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(
          Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * DAY_MS,
        ),
      },
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
