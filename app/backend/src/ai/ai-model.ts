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
    /** ログで伏せる値（API キー） */
    private readonly secrets: string[] = [],
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
      this.logger.error(
        `LLM call failed (${options.name}): ${describeLlmError(e, this.secrets)}`,
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

// API キーらしき文字列（Google: AIza…、OpenAI: sk-…、Anthropic: sk-ant-…、LangSmith: lsv2_…、Bearer …、
// URL や JSON の key / api_key）。今の SDK はキーをメッセージに入れないが、SDK の更新に備えて二重に伏せる
const API_KEY_LIKE: RegExp[] = [
  /AIza[0-9A-Za-z_-]{10,}/g,
  /\bsk-[0-9A-Za-z_-]{10,}/g,
  /\blsv2_[0-9A-Za-z_]+/g,
  /(Bearer\s+)\S+/gi,
  /([?&](?:x-)?(?:api[_-]?)?key=)[^&\s]+/gi,
  // JSON の "key":"…"（値の中のエスケープ \" も含めて伏せる）
  /("(?:x-)?(?:api[_-]?)?key"\s*:\s*")(?:\\.|[^"\\])*/gi,
  // 二重に JSON 化された \"key\":\"…\"（値は \" で終わる）
  /(\\"(?:x-)?(?:api[_-]?)?key\\"\s*:\s*\\")(?:[^"\\]|\\(?!"))*/gi,
  // ヘッダーの形（x-api-key: …）
  /((?:x-)?api[_-]?key\s*:\s*)[^\s,;"]+/gi,
];
const MAX_REASON_LENGTH = 500;

/**
 * ログに出すエラーの説明。原因（モデル名の誤り・キーの無効・利用枠の超過など）が分かるよう、
 * プロバイダの API が返したエラー（HTTP ステータス 400〜599 を持つ Error）だけは理由も 1 行で出す。
 * それ以外（出力の解析エラーなど）のメッセージには LLM の出力＝記録の内容が含まれうるので、種類だけにする。
 * 注意: status を持つ例外を投げる処理（独自のパーサーなど）を LLM の呼び出し経路に加えるときは、
 * そのメッセージに記録の内容が入らないことを確かめる
 */
export function describeLlmError(e: unknown, secrets: string[] = []): string {
  if (!(e instanceof Error)) return 'Error';
  // name が付いていればそれを使う（時間切れの DOMException は TimeoutError、LangChain の枠切れは
  // RateLimitQuotaExhaustedError など）。SDK の多くは name を設定しないので、そのときはクラス名にする
  const name =
    e.name && e.name !== 'Error' ? e.name : e.constructor?.name || 'Error';
  const status = (e as { status?: unknown }).status;
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599
  ) {
    // 429 や 5xx は LangChain が再試行を続け、応答待ちの上限で打ち切られると status のない例外になる
    return /Timeout|Abort/.test(name)
      ? `${name} (timed out or aborted; the provider may have kept returning 429 or 5xx)`
      : name;
  }
  let reason = e.message;
  // 設定したキーそのものは、形に頼らず完全一致で伏せる
  for (const secret of secrets) {
    if (secret) reason = reason.replaceAll(secret, '***');
  }
  for (const pattern of API_KEY_LIKE) {
    reason = reason.replace(pattern, (_, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}***` : '***',
    );
  }
  // 改行・制御文字・双方向テキストの制御文字は空白にして 1 行にまとめる（ログの分断や偽の行・表示の偽装を防ぐ）
  // eslint-disable-next-line no-control-regex
  reason = reason.replace(/[\s\x00-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]+/g, ' ').trim();
  return `${name} status=${status} ${reason.slice(0, MAX_REASON_LENGTH)}`;
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
    [ai.apiKey],
  );
}

/** AI が使える設定か */
export const isAiConfigured = (model: AiModel) =>
  !(model instanceof UnconfiguredAiModel);
