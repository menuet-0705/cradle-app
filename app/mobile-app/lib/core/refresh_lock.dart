// トークン更新の排他制御。Web のみブラウザの全タブで直列化する（モバイルでは何もしない）
export 'refresh_lock_stub.dart'
    if (dart.library.js_interop) 'refresh_lock_web.dart';
