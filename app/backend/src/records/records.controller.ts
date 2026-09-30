import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createRecordSchema,
  listRecordsSchema,
  dailyRangeSchema,
  type CreateRecordDto,
  type ListRecordsDto,
  type DailyRangeDto,
} from './records.dto.js';
import { RecordsService } from './records.service.js';

@Controller()
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Get('children/:childId/records')
  list(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Query(new ZodValidationPipe(listRecordsSchema)) q: ListRecordsDto,
  ) {
    return this.records.list(user.id, childId, q);
  }

  @Post('children/:childId/records')
  create(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Body(new ZodValidationPipe(createRecordSchema)) dto: CreateRecordDto,
  ) {
    return this.records.create(user.id, childId, dto);
  }

  @Patch('records/:recordId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('recordId', ParseUUIDPipe) recordId: string,
    // 本文は作成と同じ形（種類ごとの必須項目・未来の時刻の拒否も同じ）。
    // 部分更新ではなく全項目の置き換え（省いたメモは消える）
    @Body(new ZodValidationPipe(createRecordSchema)) dto: CreateRecordDto,
  ) {
    return this.records.update(user.id, recordId, dto);
  }

  @Delete('records/:recordId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('recordId', ParseUUIDPipe) recordId: string,
  ) {
    return this.records.remove(user.id, recordId);
  }

  @Get('children/:childId/stats/weight')
  weight(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.records.weightSeries(user.id, childId);
  }

  @Get('children/:childId/stats/milk-daily')
  milkDaily(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Query(new ZodValidationPipe(dailyRangeSchema)) q: DailyRangeDto,
  ) {
    return this.records.milkDaily(user.id, childId, q);
  }

  @Get('children/:childId/stats/daily-summary')
  dailySummary(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Query(new ZodValidationPipe(dailyRangeSchema)) q: DailyRangeDto,
  ) {
    return this.records.dailySummary(user.id, childId, q);
  }
}
