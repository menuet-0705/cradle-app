import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:web/web.dart' as web;

/// Web では全タブが同じリフレッシュ Cookie を共有する。
/// 複数タブが同時に更新すると、サーバーは同一トークンの同時使用（盗用の疑い）とみなして
/// 全端末のセッションを失効させるため、Web Locks でブラウザ全体の更新を 1 つずつ実行する。
Future<T> withRefreshLock<T>(Future<T> Function() task) async {
  final navigator = web.window.navigator;
  // 古いブラウザなど Web Locks がない環境ではそのまま実行する
  if (!(navigator as JSObject).has('locks')) return task();

  // 失敗は待ち受け側（await の後）で投げ直す。先に Future をエラー完了させると未処理例外になる
  late T value;
  Object? error;
  StackTrace? stackTrace;
  JSPromise<JSAny?> onGranted(web.Lock? _) => () async {
    try {
      value = await task();
    } catch (e, s) {
      error = e;
      stackTrace = s;
    }
  }().toJS;

  await navigator.locks.request('cradle-token-refresh', onGranted.toJS).toDart;
  if (error case final e?) Error.throwWithStackTrace(e, stackTrace!);
  return value;
}
