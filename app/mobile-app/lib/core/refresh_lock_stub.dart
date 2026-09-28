Future<T> withRefreshLock<T>(Future<T> Function() task) => task();
