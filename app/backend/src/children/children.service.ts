import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateChildDto, UpdateChildDto } from './children.dto.js';

export const MAX_CHILDREN_PER_FAMILY = 10;

const childSelect = {
  id: true,
  familyId: true,
  name: true,
  birthDate: true,
  sex: true,
  avoidFoods: true,
  createdAt: true,
} as const;

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
    // AI 機能の費用がこどもの数に比例して増えるので、1 家族の人数に上限を設ける。
    // 同時に登録されても超えないよう、家族単位のロックの中で数えてから作る
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`children:${familyId}`}))`;
        const count = await tx.child.count({ where: { familyId } });
        if (count >= MAX_CHILDREN_PER_FAMILY) {
          throw new ConflictException({
            code: 'CHILD_LIMIT',
            message: 'Too many children in this family',
          });
        }
        return tx.child.create({
          data: {
            familyId,
            name: dto.name,
            birthDate: new Date(dto.birthDate),
            sex: dto.sex ?? null,
            avoidFoods: dto.avoidFoods ?? null,
          },
          select: childSelect,
        });
      },
      { maxWait: 5000, timeout: 5000 },
    );
  }

  async update(userId: string, childId: string, dto: UpdateChildDto) {
    await this.assertAccess(userId, childId);
    return this.prisma.child.update({
      where: { id: childId },
      data: {
        name: dto.name,
        birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
        sex: dto.sex,
        avoidFoods: dto.avoidFoods,
      },
      select: childSelect,
    });
  }

  async remove(userId: string, childId: string) {
    await this.assertAccess(userId, childId);
    await this.prisma.child.delete({ where: { id: childId } });
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
