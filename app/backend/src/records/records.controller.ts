import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createRecordSchema,
  listRecordsSchema,
  milkDailySchema,
  type CreateRecordDto,
  type ListRecordsDto,
  type MilkDailyDto,
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
    @Query(new ZodValidationPipe(milkDailySchema)) q: MilkDailyDto,
  ) {
    return this.records.milkDaily(user.id, childId, q);
  }
}
