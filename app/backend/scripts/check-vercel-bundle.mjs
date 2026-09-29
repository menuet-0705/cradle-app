// Vercel の関数と同じ条件でアプリを起動できるか、ビルド時に確認する。手元の Node と Vercel には次の差がある。
// 1. Vercel には、依存をたどって見つかったファイル（@vercel/nft によるファイル追跡）と includeFiles だけがアップロードされる。
//    追跡は package.json の exports のパターンを解決し損ねることがあり、手元にはあるファイルが本番では見つからない
//    （例: nft 1.10.0 は openai/lib/responses/ResponseInputItems.js を落とし、本番で ERR_MODULE_NOT_FOUND になった。
//    そのため vercel.json の includeFiles に node_modules/openai/**/*.js を入れている。Vercel の nft が 1.11.0 以降になれば外せる）
// 2. Vercel の実行環境は「CommonJS から ESM を require する」読み込み（require(esm)）に対応していない
// そこで vercel.json の関数ごとに、Vercel と同じ版の @vercel/nft で集めたファイルだけを一時ディレクトリにコピーし、
// require(esm) を無効にしてアプリを初期化する（DB には接続しない）。LLM のクライアントはプロバイダごとに作るところまで確認する。
// 限界: 確認できるのは起動（app.init()）までに読み込まれるモジュールだけ。リクエスト処理中に初めて読み込まれるものは対象外。
// @vercel/nft の版は、Vercel のビルドログに出る @vercel/node の版が使うものに合わせて更新する。
import { nodeFileTrace } from '@vercel/nft';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const backendDir = resolve(import.meta.dirname, '..');
// Vercel は「Root Directory の外のファイルも含める」設定なので、リポジトリのルートを起点に追跡する
const repoRoot = resolve(backendDir, '../..');
const backendRel = relative(repoRoot, backendDir);
const vercel = JSON.parse(
  readFileSync(join(backendDir, 'vercel.json'), 'utf8'),
);

// 起動時に作る LLM クライアントを切り替えて、3 つのプロバイダすべてで確認する（ダミーのキー。通信はしない）
const PROVIDERS = [
  { LLM_PROVIDER: 'google', GOOGLE_API_KEY: 'dummy-not-a-secret' },
  { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'dummy-not-a-secret' },
  { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'dummy-not-a-secret' },
];

const script = (entry) => `
  await import('./${entry}');
  const { createApp } = await import('./dist/app.factory.js');
  const { AI_MODEL, isAiConfigured } = await import('./dist/ai/ai-model.js');
  const app = await createApp();
  await app.init();
  // 設定の読み違いで AI が無効のまま通らないよう、クライアントが作られたことを確かめる
  if (!isAiConfigured(app.get(AI_MODEL, { strict: false }))) {
    throw new Error('LLM client was not created');
  }
  await app.close();
`;

/** 関数にアップロードされるファイルだけを一時ディレクトリにコピーする */
async function buildBundle(entry, includeFiles) {
  // @vercel/node の呼び出しに合わせる（base / processCwd / mixedModules）
  const { fileList, warnings } = await nodeFileTrace(
    [join(backendDir, entry)],
    { base: repoRoot, processCwd: backendDir, mixedModules: true },
  );
  const included = includeFiles
    ? globSync(includeFiles, { cwd: backendDir }).map((f) =>
        join(backendRel, f),
      )
    : [];
  const bundle = mkdtempSync(join(tmpdir(), 'vercel-bundle-'));
  try {
    for (const file of new Set([...fileList, ...included])) {
      const src = join(repoRoot, file);
      if (!statSync(src).isFile()) continue;
      mkdirSync(dirname(join(bundle, file)), { recursive: true });
      // リンクは実体をコピーする（一時ディレクトリの外の node_modules が見えないように）
      cpSync(src, join(bundle, file), { dereference: true });
    }
  } catch (e) {
    rmSync(bundle, { recursive: true, force: true });
    throw e;
  }
  return { bundle, warningCount: warnings.size };
}

function explain(stderr, entry) {
  if (/ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE/.test(stderr)) {
    return 'a CommonJS dependency requires an ESM-only package. This fails on Vercel (no require(esm) support).';
  }
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(stderr)) {
    return `a file is missing from the Vercel function (${entry}). Add it to includeFiles in vercel.json.`;
  }
  return `the Vercel bundle check could not start the app (${entry}).`;
}

let failed = false;
for (const [entry, fn] of Object.entries(vercel.functions)) {
  const { bundle, warningCount } = await buildBundle(entry, fn.includeFiles);
  try {
    for (const provider of PROVIDERS) {
      try {
        execFileSync(
          process.execPath,
          [
            '--no-experimental-require-module',
            '--input-type=module',
            '-e',
            script(entry),
          ],
          {
            cwd: join(bundle, backendRel),
            stdio: 'pipe',
            // 終了しない場合にビルドを止めたままにしない
            timeout: 60_000,
            // 検査専用のダミー値（接続はしない）。実際の環境変数は子プロセスに渡さない
            env: {
              PATH: process.env.PATH,
              NODE_ENV: 'production',
              DATABASE_URL: 'postgresql://check:check@127.0.0.1:1/check',
              JWT_ACCESS_SECRET: 'vercel-bundle-check-dummy-not-a-secret-0123',
              ...provider,
            },
          },
        );
      } catch (e) {
        for (const out of [e.stdout, e.stderr]) {
          if (out?.length) console.error(String(out));
        }
        console.error(
          `code=${e.code ?? ''} signal=${e.signal ?? ''} provider=${provider.LLM_PROVIDER}`,
        );
        console.error(
          `error: ${explain(String(e.stderr ?? e.message), entry)}`,
        );
        failed = true;
        break;
      }
    }
  } finally {
    rmSync(bundle, { recursive: true, force: true });
  }
  if (failed) break;
  console.log(
    `Vercel bundle check passed: ${entry} (${PROVIDERS.length} providers, ${warningCount} trace warnings)`,
  );
}
if (failed) process.exitCode = 1;
