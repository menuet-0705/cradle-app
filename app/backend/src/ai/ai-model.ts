import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import {
  BadGatewayException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { z } from 'zod';
import type { AiConfig, AppConfig } from '../config/env.js';

/** LLM。テストではこのトークンを差し替える */
export const AI_MODEL = Symbol('AI_MODEL');

export interface AiModel {
  /** 保存・ログ用の名前（例: google:gemini-3.8-flash） */
  readonly name: string;
  /** メッセージを渡し、スキーマどおりの構造化データを受け取る */
  generate<T extends Record<string, unknown>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    options: GenerateOptions,
  ): Promise<T>;
}

export interface GenerateOptions {
  /** 構造化出力のツール名など、ログに出す処理名 */
  name: string;
}

/**
 * 1 回の呼び出しで応答を待つ上限（再試行を含む）。
 * 食事の提案は 2 回呼ぶので、2 回分と DB・起動の時間を足しても Vercel の制限時間（60 秒）に収まるようにする
 */
export const LLM_TIMEOUT_MS = 20_000;

/** LangChain のチャットモデルで生成する。プロバイダの違いはここだけで吸収する */
export class LangChainAiModel implements AiModel {
  private readonly logger = new Logger(LangChainAiModel.name);

  constructor(
    readonly name: string,
    private readonly chat: BaseChatModel,
  ) {}

  async generate<T extends Record<string, unknown>>(
    schema: z.ZodType<T>,
    messages: BaseMessage[],
    options: GenerateOptions,
  ): Promise<T> {
    let output: unknown;
    try {
      output = await this.chat
        .withStructuredOutput(schema, { name: options.name })
        .invoke(messages, {
          timeout: LLM_TIMEOUT_MS,
        });
    } catch (e) {
      // 例外の内容にはリクエスト内容や API キーの一部が含まれうるので、名前だけ出す
      this.logger.error(
        `LLM call failed (${options.name}): ${(e as Error).name}`,
      );
      throw new BadGatewayException('AI generation failed');
    }
    // プロバイダによっては検証前の値が返るので、ここで必ず検証する
    const parsed = schema.safeParse(output);
    if (!parsed.success) {
      this.logger.error(`LLM returned an invalid structure (${options.name})`);
      throw new BadGatewayException('AI generation failed');
    }
    return parsed.data;
  }
}

/** AI が未設定のとき。呼ばれたら 503 */
class UnconfiguredAiModel implements AiModel {
  readonly name = 'unconfigured';

  generate(): Promise<never> {
    return Promise.reject(
      new ServiceUnavailableException('AI is not configured'),
    );
  }
}

function createChatModel(ai: AiConfig): BaseChatModel {
  // temperature などはプロバイダの既定値に任せる（推論モデルでは指定できないものがあり、切り替え時の差を減らす）
  const common = { model: ai.model, apiKey: ai.apiKey, maxRetries: 1 };
  // initChatModel（動的 import）は Vercel のファイル追跡で取りこぼす恐れがあるため、静的 import で切り替える
  switch (ai.provider) {
    case 'google':
      return new ChatGoogleGenerativeAI({ ...common });
    case 'openai':
      return new ChatOpenAI({ ...common });
    case 'anthropic':
      return new ChatAnthropic({ ...common });
  }
}

/** 設定に応じた LLM を作る（違いは環境変数だけ） */
export function createAiModel(config: AppConfig): AiModel {
  const ai = config.ai;
  if (!ai) return new UnconfiguredAiModel();
  return new LangChainAiModel(
    `${ai.provider}:${ai.model}`,
    createChatModel(ai),
  );
}

/** AI が使える設定か */
export const isAiConfigured = (model: AiModel) =>
  !(model instanceof UnconfiguredAiModel);
