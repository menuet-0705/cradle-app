import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  aiConsentSchema,
  createInviteSchema,
  inviteCodeSchema,
  type AiConsentDto,
  type CreateInviteDto,
  type InviteCodeDto,
} from './families.dto.js';
import { FamiliesService } from './families.service.js';

// コードの総当たり対策。約 50 ビットのコードに加えて宛先アドレスとの一致も必要なので、
// インスタンス単位の簡易な制限（preview / accept それぞれ 1 分 10 回）でも推測は現実的でない
const INVITE_CODE_LIMIT = { limit: 10, ttlMs: 60_000 };
// メール送信は 1 ユーザー 1 時間 10 通の上限もサービス側で持つ
const SEND_LIMIT = { limit: 10, ttlMs: 60_000 };

@Controller()
export class FamiliesController {
  constructor(private readonly families: FamiliesService) {}

  @Get('families')
  list(@CurrentUser() user: AuthUser) {
    return this.families.list(user.id);
  }

  /** AI 機能への同意（管理者のみ）。画面で説明した同意の版を送る */
  @HttpCode(200)
  @Post('families/:familyId/ai-consent')
  consentAi(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @Body(new ZodValidationPipe(aiConsentSchema)) dto: AiConsentDto,
  ) {
    return this.families.setAiConsent(user.id, familyId, dto);
  }

  /** AI 機能への同意の取り消し（管理者のみ） */
  @HttpCode(200)
  @Delete('families/:familyId/ai-consent')
  revokeAi(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
  ) {
    return this.families.setAiConsent(user.id, familyId, null);
  }

  @RateLimit(SEND_LIMIT)
  @Post('families/:familyId/invites')
  createInvite(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @Body(new ZodValidationPipe(createInviteSchema)) dto: CreateInviteDto,
  ) {
    return this.families.createInvite(user.id, familyId, dto.email);
  }

  @Get('families/:familyId/invites')
  listInvites(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
  ) {
    return this.families.listInvites(user.id, familyId);
  }

  @Delete('families/:familyId/invites/:inviteId')
  @HttpCode(204)
  revokeInvite(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ) {
    return this.families.revokeInvite(user.id, familyId, inviteId);
  }

  // コードは URL ではなく本文で受け取る（API のアクセスログに残さない。Web のリンクも # 以降に置く）
  @RateLimit(INVITE_CODE_LIMIT)
  @HttpCode(200)
  @Post('invites/preview')
  preview(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(inviteCodeSchema)) dto: InviteCodeDto,
  ) {
    return this.families.preview(user.id, dto.code);
  }

  @RateLimit(INVITE_CODE_LIMIT)
  @HttpCode(200)
  @Post('invites/accept')
  accept(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(inviteCodeSchema)) dto: InviteCodeDto,
  ) {
    return this.families.accept(user.id, dto.code);
  }

  @Delete('families/:familyId/members/:userId')
  @HttpCode(204)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('familyId', ParseUUIDPipe) familyId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.families.removeMember(user.id, familyId, targetUserId);
  }
}
