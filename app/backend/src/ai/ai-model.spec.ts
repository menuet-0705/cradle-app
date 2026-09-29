import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../config/env.js';
import {
  createAiModel,
  describeLlmError,
  LangChainAiModel,
} from './ai-model.js';

class NotFoundError extends Error {
  status = 404;
}
const apiError = (message: string, status: unknown = 400) =>
  Object.assign(new Error(message), { status });

describe('describeLlmError', () => {
  it('shows the status and reason of provider API errors in one line', () => {
    const text = describeLlmError(
      new NotFoundError(
        '[GoogleGenerativeAI Error]: [404 Not Found] models/gemini-x is not found\n\nTroubleshooting URL: https://example.com',
      ),
    );
    expect(text).toBe(
      'NotFoundError status=404 [GoogleGenerativeAI Error]: [404 Not Found] models/gemini-x is not found Troubleshooting URL: https://example.com',
    );
  });

  it('masks API keys, keeping the parameter names', () => {
    const text = describeLlmError(
      apiError(
        [
          'url https://x/models/m:generateContent?key=AIzaSyDUMMY0123456789&alt=sse',
          'other ?KEY=abc&api_key=def',
          'openai sk-proj-abcdefghijklmnop',
          'anthropic sk-ant-api03-abcdefghijklmnop',
          'langsmith lsv2_pt_abc123',
          'header Bearer tok123',
          'json {"key":"k-123","api_key":"v"}',
          'configured my-secret-value',
        ].join(' '),
      ),
      ['my-secret-value'],
    );
    for (const leaked of [
      'AIzaSy',
      'abc&',
      'def',
      'abcdefghijklmnop',
      'lsv2_pt',
      'tok123',
      'k-123',
      'my-secret-value',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('?key=***&alt=sse');
    expect(text).toContain('api_key=***');
    expect(text).toContain('Bearer ***');
    expect(text).toContain('"key":"***"');
    // sk- の前が語の途中なら伏せない
    expect(describeLlmError(apiError('task-abcdefghijk'))).toContain(
      'task-abcdefghijk',
    );
  });

  it('truncates long reasons', () => {
    const text = describeLlmError(apiError('x'.repeat(1_000)));
    expect(text).toBe(`Error status=400 ${'x'.repeat(500)}`);
  });

  it('hides messages of other errors (they may contain the model output)', () => {
    expect(
      describeLlmError(new Error('failed to parse: かぼちゃがゆ 完食')),
    ).toBe('Error');
    expect(describeLlmError(apiError('かぼちゃ', '404'))).toBe('Error');
    expect(describeLlmError(apiError('かぼちゃ', 200))).toBe('Error');
    expect(describeLlmError('かぼちゃ')).toBe('Error');
    expect(describeLlmError(null)).toBe('Error');
    expect(describeLlmError(undefined)).toBe('Error');
  });

  it('keeps the name of timeouts (DOMException) and hints at retries', () => {
    // LangChain の invoke({ timeout }) は AbortSignal.timeout() の reason（DOMException）で reject する
    const e = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    expect(describeLlmError(e)).toBe(
      'TimeoutError (timed out or aborted; the provider may have kept returning 429 or 5xx)',
    );
  });

  it('keeps names set by LangChain over class names', () => {
    const e = new NotFoundError('quota');
    e.name = 'RateLimitQuotaExhaustedError';
    expect(describeLlmError(e)).toMatch(/^RateLimitQuotaExhaustedError /);
  });

  it('masks keys in escaped JSON and headers, and collapses C1 controls', () => {
    const text = describeLlmError(
      apiError(
        [
          '{"error":"{\\"key\\":\\"nested-secret\\"}"}',
          '{"key":"ab\\"cdef"}',
          'x-api-key: hdr-secret',
          '"x-api-key":"json-secret"',
          'line\u0085break',
        ].join(' '),
      ),
    );
    for (const leaked of [
      'nested-secret',
      'cdef',
      'hdr-secret',
      'json-secret',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).not.toContain('\u0085');
  });
});

describe('LangChainAiModel', () => {
  it('masks the configured API key in the log', async () => {
    const config = {
      ai: {
        provider: 'google',
        model: 'gemini-x',
        apiKey: 'configured-key-123',
      },
    } as AppConfig;
    // createAiModel が設定の API キーを伏せ字の対象として渡していること
    expect(
      (createAiModel(config) as unknown as { secrets: string[] }).secrets,
    ).toEqual(['configured-key-123']);

    const chat = {
      withStructuredOutput: () => ({
        invoke: () =>
          Promise.reject(apiError('invalid key configured-key-123', 400)),
      }),
    } as unknown as BaseChatModel;
    const model = new LangChainAiModel('google:gemini-x', chat, [
      'configured-key-123',
    ]);
    const logged: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m: unknown) => void logged.push(String(m)));
    try {
      await expect(
        model.generate(z.object({ a: z.string() }), [], { name: 't' }),
      ).rejects.toThrow('AI generation failed');
    } finally {
      spy.mockRestore();
    }
    expect(logged.join('\n')).toContain('status=400 invalid key ***');
    expect(logged.join('\n')).not.toContain('configured-key-123');
  });
});
