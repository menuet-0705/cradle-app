// ローカル API に対して、アプリの通信コードをそのまま動かす結合テスト。
// API 起動中に `API_CONTRACT_BASE_URL=http://localhost:3000/api/v1 flutter test test/api_contract_test.dart`
// で実行する（未指定ならスキップ）。
import 'dart:io';

import 'package:cradle/core/api_client.dart';
import 'package:cradle/features/ai/ai_providers.dart';
import 'package:cradle/features/auth/auth_repository.dart';
import 'package:cradle/features/auth/session.dart';
import 'package:cradle/features/children/child.dart';
import 'package:cradle/features/children/children_providers.dart';
import 'package:cradle/features/records/growth_record.dart';
import 'package:cradle/features/records/records_providers.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final baseUrl = Platform.environment['API_CONTRACT_BASE_URL'];

  test('signup → child → records → stats → refresh → logout', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // テストバインディングは HTTP を無効化するので、実通信に戻す
    HttpOverrides.global = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('flutter_timezone'),
          (call) async => {'identifier': 'Asia/Tokyo'},
        );
    FlutterSecureStorage.setMockInitialValues({});

    final session = Session();
    final auth = AuthRepository(createBareDio(baseUrl!), session);
    final dio = createAuthedDio(baseUrl, session);
    final children = ChildrenRepository(dio);
    final records = RecordsRepository(dio);

    await auth.signup(
      email: 'contract-${DateTime.now().microsecondsSinceEpoch}@example.com',
      password: 'password123',
      name: 'テスト',
    );
    expect(session.isLoggedIn, isTrue);

    final child = await children.create(
      name: 'たろう',
      birthDate: DateTime(2026, 4, 1),
      sex: Sex.male,
    );
    expect(child.birthDate, DateTime(2026, 4, 1));
    expect((await children.list()).single.id, child.id);

    final now = DateTime.now();
    await records.create(
      child.id,
      NewRecord(type: RecordType.milk, startedAt: now, amountMl: 120),
    );
    await records.create(
      child.id,
      NewRecord(
        type: RecordType.sleep,
        startedAt: now.subtract(const Duration(hours: 2)),
        endedAt: now.subtract(const Duration(hours: 1)),
      ),
    );
    await records.create(
      child.id,
      NewRecord(type: RecordType.weight, startedAt: now, weightG: 5250),
    );

    final day = await records.listForDay(child.id, now);
    expect(day.map((r) => r.type).toSet(), {
      RecordType.milk,
      RecordType.weight,
      // 深夜0〜2時に実行すると睡眠は前日扱いになるため含めない
      if (now.hour >= 2) RecordType.sleep,
    });

    final milk = await records.milkDaily(child.id, from: now, to: now);
    expect(milk.single.totalMl, 120);
    expect((await records.weightSeries(child.id)).single.weightG, 5250);

    // AI による分析（ローカルでは AI 未設定のこともあるので、生成はせず読み取りと設定だけ確認する）
    final ai = AiRepository(dio);
    final meal = await ai.latestMealSuggestion(child.id);
    expect(meal.suggestion, isNull);
    expect(meal.remainingToday, 3);
    expect(await ai.weeklyReports(child.id), isEmpty);
    expect(await ai.weeklyReportEmail(), isTrue);
    expect(await ai.setWeeklyReportEmail(false), isFalse);
    expect(await ai.weeklyReportEmail(), isFalse);

    // アクセストークンを壊しても、リフレッシュして再送できる
    await session.save(
      Tokens(
        accessToken: 'expired',
        refreshToken: session.tokens!.refreshToken,
      ),
    );
    expect((await children.list()), hasLength(1));
    expect(session.tokens!.accessToken, isNot('expired'));

    await records.delete(day.first.id);
    await auth.logout();
    expect(session.isLoggedIn, isFalse);
  }, skip: baseUrl == null ? 'API_CONTRACT_BASE_URL is not set' : false);
}
