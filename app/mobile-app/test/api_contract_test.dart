// ローカル API に対して、アプリの通信コードをそのまま動かす結合テスト。
// API 起動中に `API_CONTRACT_BASE_URL=http://localhost:3000/api/v1 flutter test test/api_contract_test.dart`
// で実行する（未指定ならスキップ）。
import 'dart:io';

import 'package:cradle/core/api_client.dart';
import 'package:cradle/features/ai/ai_models.dart';
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
    // 同じ日の 2 回目の体重は上書きされる
    await records.create(
      child.id,
      NewRecord(type: RecordType.weight, startedAt: now, weightG: 5300),
    );
    // 食事は同じ日・同じ区分の 2 回目が上書きされる
    for (final note in ['パン', 'おにぎり']) {
      await records.create(
        child.id,
        NewRecord(
          type: RecordType.meal,
          startedAt: now,
          mealSlot: MealSlot.breakfast,
          note: note,
        ),
      );
    }

    var day = await records.listForDay(child.id, now);
    // 記録の修正（種類ごとの本文の形・タイムゾーンの付け方が作成と同じであること）
    final milkRecord = day.firstWhere((r) => r.type == RecordType.milk);
    await records.update(
      milkRecord.id,
      NewRecord(
        type: RecordType.milk,
        startedAt: milkRecord.startedAt,
        amountMl: 130,
      ),
    );
    final breakfast = day.firstWhere((r) => r.type == RecordType.meal);
    await records.update(
      breakfast.id,
      NewRecord(
        type: RecordType.meal,
        startedAt: breakfast.startedAt,
        mealSlot: MealSlot.breakfast,
        note: 'おにぎり（修正）',
      ),
    );
    day = await records.listForDay(child.id, now);
    expect(day.firstWhere((r) => r.type == RecordType.milk).amountMl, 130);
    final meals = day.where((r) => r.type == RecordType.meal);
    expect(meals.single.mealSlot, MealSlot.breakfast);
    expect(meals.single.note, 'おにぎり（修正）');
    expect(day.map((r) => r.type).toSet(), {
      RecordType.milk,
      RecordType.weight,
      RecordType.meal,
      // 深夜0〜2時に実行すると睡眠は前日扱いになるため含めない
      if (now.hour >= 2) RecordType.sleep,
    });

    final milk = await records.milkDaily(child.id, from: now, to: now);
    expect(milk.single.totalMl, 130);
    expect((await records.weightSeries(child.id)).single.weightG, 5300);

    // AI による分析（ローカルでは AI 未設定のこともあるので、生成はせず読み取りと設定だけ確認する）
    final ai = AiRepository(dio);
    final meal = await ai.latestMealSuggestion(child.id);
    expect(meal.suggestion, isNull);
    expect(meal.remainingToday, 3);
    expect(await ai.weeklyReports(child.id), isEmpty);
    // グラフのコメント: 状態を読めること（AI の有無はローカルの設定しだいなので生成はしない）
    for (final chart in ChartKind.values) {
      final state = await ai.chartComment(child.id, chart);
      expect(state.comment, isNull);
      expect(state.limitReached, isFalse);
      // 今日の体重・ミルクを記録済みで、今日のコメントはまだないので、AI が使えるなら作成を求められる
      expect(state.needsUpdate, state.enabled);
    }
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
