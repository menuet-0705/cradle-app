// AI（LLM の応答待ち）と定期実行用の Vercel Function。中身は api/index.js と同じアプリで、
// 制限時間（maxDuration）だけを長くするために分けている（他の API は短いまま）
export { default } from '../dist/serverless.js';
