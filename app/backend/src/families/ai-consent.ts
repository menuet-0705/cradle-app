/**
 * AI 機能（食事の提案・週次レポート）の同意の版。
 * 送るデータや送り先など、同意の内容を変えたら上げる（古い版の同意は無効になり、再同意が必要）
 */
export const AI_CONSENT_VERSION = 1;

/** Prisma の Family に対する「AI 機能を使ってよい家族」の条件 */
export const aiEnabledFamily = {
  aiConsentAt: { not: null },
  aiConsentVersion: AI_CONSENT_VERSION,
} as const;
