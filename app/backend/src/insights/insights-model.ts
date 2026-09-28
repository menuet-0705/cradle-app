import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import {
  clampMealSuggestion,
  clampWeeklyReport,
  mealSuggestionContentSchema,
  weeklyReportContentSchema,
  type MealSuggestionContent,
  type WeeklyReportContent,
} from './insights.schemas.js';
import {
  MEAL_SUGGESTION_SYSTEM,
  WEEKLY_REPORT_SYSTEM,
  mealSuggestionUserMessage,
  weeklyReportUserMessage,
} from './prompts.js';
import type { MealSuggestionInput, WeeklyReportInput } from './aggregate.js';

/** Claude の呼び出し。e2e テストではこのトークンを差し替えて実 API を呼ばない */
export const INSIGHTS_MODEL = Symbol('INSIGHTS_MODEL');

export interface BatchOutcome {
  /** まだ処理中なら false（結果は空） */
  ended: boolean;
  /** custom_id ごとの結果。生成できなかったものは null */
  results: Map<string, WeeklyReportContent | null>;
}

export interface FetchOptions {
  /** 1 回の通信の制限時間（既定 10 秒） */
  timeoutMs?: number;
  /** 再試行の回数（既定 0。Cron は翌日また試すので、ここでは粘らない） */
  maxRetries?: number;
  /** これらの結果がそろったら読むのをやめる（画面表示から、そのこどもの分だけ欲しいとき） */
  onlyIds?: Set<string>;
}

export interface InsightsModel {
  readonly modelName: string;
  suggestMeals(input: MealSuggestionInput): Promise<MealSuggestionContent>;
  submitWeeklyReports(
    items: { customId: string; input: WeeklyReportInput }[],
  ): Promise<string>;
  fetchWeeklyReports(
    batchId: string,
    options?: FetchOptions,
  ): Promise<BatchOutcome>;
}

const body = (code: string, message: string) => ({ code, message });
export const aiUnavailable = (message = 'AI is not available') =>
  new HttpException(
    body('AI_UNAVAILABLE', message),
    HttpStatus.SERVICE_UNAVAILABLE,
  );

// 出力（思考を含む）の上限。構造化出力の JSON が収まる十分な大きさ
const MAX_TOKENS = 8000;
// 思考の深さ。献立・ふりかえり程度なら medium で十分で、応答も速い
const EFFORT = 'medium' as const;
// Batch の操作は短く区切る（Cron・画面表示の処理が Vercel の制限時間 60 秒を超えないように）。
// 失敗しても翌日の Cron で再試行されるので、ここでは再試行しない
const BATCH_CALL = { timeout: 10_000, maxRetries: 0 };

const mealFormat = zodOutputFormat(mealSuggestionContentSchema);
const reportFormat = zodOutputFormat(weeklyReportContentSchema);

@Injectable()
export class AnthropicInsightsModel implements InsightsModel {
  private readonly logger = new Logger(AnthropicInsightsModel.name);
  private readonly client?: Anthropic;
  readonly modelName: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.modelName = config.ai?.model ?? config.CLAUDE_MODEL;
    if (config.ai) {
      this.client = new Anthropic({
        apiKey: config.ai.apiKey,
        // 接続先は検証済みの設定だけから決める（環境変数の読み込みに任せない）
        baseURL: config.ai.baseUrl,
        // 同期の提案は Vercel の制限時間（60 秒）内に終える。再試行もしない
        timeout: 50_000,
        maxRetries: 0,
      });
    }
  }

  private get api(): Anthropic {
    // 設定の有無は利用者に見せない
    if (!this.client) throw aiUnavailable();
    return this.client;
  }

  async suggestMeals(input: MealSuggestionInput) {
    try {
      const res = await this.api.messages.parse({
        model: this.modelName,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        output_config: { effort: EFFORT, format: mealFormat },
        system: MEAL_SUGGESTION_SYSTEM,
        messages: [{ role: 'user', content: mealSuggestionUserMessage(input) }],
      });
      if (res.stop_reason === 'refusal') {
        throw aiUnavailable('The request was declined');
      }
      if (!res.parsed_output) throw aiUnavailable('Invalid AI response');
      return clampMealSuggestion(res.parsed_output);
    } catch (e) {
      throw this.translate(e);
    }
  }

  async submitWeeklyReports(
    items: { customId: string; input: WeeklyReportInput }[],
  ) {
    const format = { type: reportFormat.type, schema: reportFormat.schema };
    try {
      const batch = await this.api.messages.batches.create(
        {
          requests: items.map(({ customId, input }) => ({
            custom_id: customId,
            params: {
              model: this.modelName,
              max_tokens: MAX_TOKENS,
              thinking: { type: 'adaptive' },
              output_config: { effort: EFFORT, format },
              system: WEEKLY_REPORT_SYSTEM,
              messages: [
                { role: 'user', content: weeklyReportUserMessage(input) },
              ],
            },
          })),
        },
        BATCH_CALL,
      );
      return batch.id;
    } catch (e) {
      throw this.translate(e);
    }
  }

  async fetchWeeklyReports(
    batchId: string,
    options: FetchOptions = {},
  ): Promise<BatchOutcome> {
    const results = new Map<string, WeeklyReportContent | null>();
    const call = {
      timeout: options.timeoutMs ?? BATCH_CALL.timeout,
      maxRetries: options.maxRetries ?? BATCH_CALL.maxRetries,
    };
    try {
      const batch = await this.api.messages.batches.retrieve(batchId, {}, call);
      if (batch.processing_status !== 'ended') return { ended: false, results };
      const wanted = options.onlyIds;
      for await (const item of await this.api.messages.batches.results(
        batchId,
        {},
        call,
      )) {
        if (wanted && !wanted.has(item.custom_id)) continue;
        results.set(item.custom_id, this.parseReport(item));
        if (wanted && results.size >= wanted.size) break;
      }
      return { ended: true, results };
    } catch (e) {
      // Batch が見つからない: API キーの取り違えなど一時的な原因もありうるので、ここでは失敗扱いにしない
      // （PENDING のまま残し、一定時間を過ぎたら回収側で失敗扱いにする）
      if (e instanceof Anthropic.NotFoundError) {
        this.logger.error(`Weekly report batch not found: ${batchId}`);
        return { ended: false, results };
      }
      throw this.translate(e);
    }
  }

  private parseReport(
    item: Anthropic.Messages.MessageBatchIndividualResponse,
  ): WeeklyReportContent | null {
    if (item.result.type !== 'succeeded') {
      this.logger.warn(`Weekly report failed: ${item.result.type}`);
      return null;
    }
    const message = item.result.message;
    if (message.stop_reason !== 'end_turn') {
      this.logger.warn(`Weekly report stopped: ${message.stop_reason}`);
      return null;
    }
    const text = message.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      this.logger.warn('Weekly report has no text block');
      return null;
    }
    try {
      return clampWeeklyReport(reportFormat.parse(text.text));
    } catch {
      this.logger.warn('Weekly report did not match the schema');
      return null;
    }
  }

  /** SDK のエラーを利用者向けのエラーにする（詳細はログにだけ出す） */
  private translate(e: unknown): unknown {
    if (e instanceof HttpException) return e;
    if (e instanceof Anthropic.RateLimitError) {
      this.logger.warn('Claude API rate limited');
      return new HttpException(
        body('AI_BUSY', 'AI is busy'),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (e instanceof Anthropic.APIError) {
      this.logger.error(`Claude API error: ${e.status ?? 'network'} ${e.name}`);
      return aiUnavailable();
    }
    this.logger.error(`Claude call failed: ${(e as Error).name}`);
    return aiUnavailable();
  }
}
