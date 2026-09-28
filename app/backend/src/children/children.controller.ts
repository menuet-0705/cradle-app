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
} from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  createChildSchema,
  updateChildSchema,
  type CreateChildDto,
  type UpdateChildDto,
} from './children.dto.js';
import { ChildrenService } from './children.service.js';

@Controller('children')
export class ChildrenController {
  constructor(private readonly children: ChildrenService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.children.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createChildSchema)) dto: CreateChildDto,
  ) {
    return this.children.create(user.id, dto);
  }

  @Patch(':childId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Body(new ZodValidationPipe(updateChildSchema)) dto: UpdateChildDto,
  ) {
    return this.children.update(user.id, childId, dto);
  }

  @Delete(':childId')
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('childId', ParseUUIDPipe) childId: string,
  ) {
    return this.children.remove(user.id, childId);
  }
}
