// ブラウザのアドレスバーの URL を、履歴を増やさずに書き換える（Web 以外では何もしない）
export 'browser_url_stub.dart'
    if (dart.library.js_interop) 'browser_url_web.dart';
