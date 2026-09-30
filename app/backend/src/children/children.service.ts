import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateChildDto, UpdateChildDto } from './children.dto.js';

/** 1 家族あたりのこどもの人数の上限 */
export const MAX_CHILDREN_PER_FAMILY = 10;

const childSelect = {
  id: true,
  familyId: true,
  name: true,
  birthDate: true,
  sex: true,
  createdAt: true,
} as const;

/**
 * 家族のこどもの人数を確認してから登録・削除するためのロック（トランザクションの終わりで外れる）。
 * 登録と削除で同じキーを使い、人数の確認を追い越されないようにする
 * （キー名の create は、登録だけで使っていたころの名残。動いている処理とキーを揃えるため変えない）
 */
async function lockFamilyChildren(
  tx: Prisma.TransactionClient,
  familyId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('children:create:' || ${familyId}))`;
}

@Injectable()
export class ChildrenService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.child.findMany({
      where: { family: { members: { some: { userId } } } },
      select: childSelect,
      orderBy: { birthDate: 'asc' },
    });
  }

  async create(userId: string, dto: CreateChildDto) {
    const membership = await this.prisma.familyMember.findFirst({
      where: { userId, ...(dto.familyId && { familyId: dto.familyId }) },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new NotFoundException('Family not found');
    const familyId = membership.familyId;

    // AI の提案・レポートの費用や通知メールを、こどもを大量に作って増やせないようにする。
    // 人数の確認と作成を同時リクエストで追い越されないよう、家族ごとのロックを取って 1 件ずつ行う
    return this.prisma.$transaction(async (tx) => {
      await lockFamilyChildren(tx, familyId);
      const count = await tx.child.count({ where: { familyId } });
      if (count >= MAX_CHILDREN_PER_FAMILY) {
        throw new ConflictException({
          message: 'Too many children in the family',
          code: 'TOO_MANY_CHILDREN',
        });
      }
      return tx.child.create({
        data: {
          familyId,
          name: dto.name,
          birthDate: new Date(dto.birthDate),
          sex: dto.sex ?? null,
        },
        select: childSelect,
      });
    });
  }

  async update(userId: string, childId: string, dto: UpdateChildDto) {
    await this.assertAccess(userId, childId);
    return this.prisma.child.update({
      where: { id: childId },
      data: {
        name: dto.name,
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
        sex: dto.sex,
      },
      select: childSelect,
    });
  }

  /**
   * こどもの削除（記録・AI の結果もまとめて消える）。家族のこどもが 0 人にならないよう、
   * 最後の 1 人は削除できない（409 LAST_CHILD）
   */
  async remove(userId: string, childId: string) {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, family: { members: { some: { userId } } } },
      select: { familyId: true },
    });
    if (!child) throw new NotFoundException('Child not found');
    const { familyId } = child;

    // 同時に 2 人を削除して 0 人になるのを防ぐ。登録と同じロックで、人数の確認と削除を 1 件ずつ行う
    await this.prisma.$transaction(async (tx) => {
      await lockFamilyChildren(tx, familyId);
      const count = await tx.child.count({ where: { familyId } });
      if (count <= 1) {
        throw new ConflictException({
          message: 'Cannot delete the last child in the family',
          code: 'LAST_CHILD',
        });
      }
      // ロックを待つ間に消されていた・家族から外されていたら 404
      const { count: deleted } = await tx.child.deleteMany({
        where: {
          id: childId,
          familyId,
          family: { members: { some: { userId } } },
        },
      });
      if (deleted === 0) throw new NotFoundException('Child not found');
    });
  }

  /**
   * 本人が所属する家族のこどもでなければ 404。
   * 403 を返すと他家族のこどもの存在が推測できるため区別しない。
   */
  async assertAccess(userId: string, childId: string): Promise<void> {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, family: { members: { some: { userId } } } },
      select: { id: true },
    });
    if (!child) throw new NotFoundException('Child not found');
  }
}
