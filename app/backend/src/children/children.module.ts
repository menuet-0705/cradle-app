import { Module } from '@nestjs/common';
import { ChildrenController } from './children.controller.js';
import { ChildrenService } from './children.service.js';

@Module({
  controllers: [ChildrenController],
  providers: [ChildrenService],
  exports: [ChildrenService],
})
export class ChildrenModule {}
