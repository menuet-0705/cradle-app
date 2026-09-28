import 'package:web/web.dart' as web;

void replaceBrowserUrl(String path) =>
    web.window.history.replaceState(null, '', path);
