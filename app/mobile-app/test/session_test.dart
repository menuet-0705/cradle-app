import 'package:cradle/features/auth/session.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const a = Tokens(accessToken: 'a1', refreshToken: 'r1');
  const b = Tokens(accessToken: 'a2', refreshToken: 'r2');

  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  Future<Session> reloaded() async {
    final s = Session();
    await s.load();
    return s;
  }

  test('stale save after logout does not log back in', () async {
    final session = Session();
    await session.save(a);
    final epoch = session.epoch;
    await session.clear();

    expect(await session.save(b, expectedEpoch: epoch), isFalse);
    expect(session.isLoggedIn, isFalse);
    expect((await reloaded()).isLoggedIn, isFalse);
  });

  test('stale save does not wipe a newer login', () async {
    final session = Session();
    await session.save(a);
    final epoch = session.epoch;
    await session.clear();
    await session.save(b); // 再ログイン

    expect(
      await session.save(
        const Tokens(accessToken: 'x', refreshToken: 'y'),
        expectedEpoch: epoch,
      ),
      isFalse,
    );
    expect(session.tokens?.refreshToken, 'r2');
    expect((await reloaded()).tokens?.refreshToken, 'r2');
  });

  test('web mode keeps tokens in memory only', () async {
    final session = Session(persist: false);
    await session.save(const Tokens(accessToken: 'a'));
    expect(session.isLoggedIn, isTrue);
    expect((await reloaded()).isLoggedIn, isFalse);

    final web = Session(persist: false);
    await web.load();
    expect(web.isLoggedIn, isFalse);
  });
}
