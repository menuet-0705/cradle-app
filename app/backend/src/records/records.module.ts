import { Module } from '@nestjs/common';
import { ChildrenModule } from '../children/children.module.js';
import { RecordsController } from './records.controller.js';
import { RecordsService } from './records.service.js';

@Module({
  imports: [ChildrenModule],
  controllers: [RecordsController],
  providers: [RecordsService],
  // グラフの AI コメントがミルクの日別集計を使う
  exports: [RecordsService],
})
export class RecordsModule {}
