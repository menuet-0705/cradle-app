import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

export interface AuthUser {
  id: string;
}

export type AuthedRequest = Request & { user?: AuthUser };

export const IS_PUBLIC = 'isPublic';

/** 認証不要なエンドポイントに付ける（デフォルトは全て要認証） */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new Error('CurrentUser used on a public route');
    return user;
  },
);
