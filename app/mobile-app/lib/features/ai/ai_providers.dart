import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/providers.dart';
import 'ai_models.dart';

class AiRepository {
  AiRepository(this._dio);

  final Dio _dio;

  Future<MealSuggestionState> latestMealSuggestion(String childId) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '/children/$childId/ai/meal-suggestions/latest',
    );
    return MealSuggestionState.fromJson(res.data!);
  }

  Future<MealSuggestionState> createMealSuggestion(String childId) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/children/$childId/ai/meal-suggestions',
      // AI の生成は数十秒かかることがある（サーバー側の上限は 60 秒）
      options: Options(receiveTimeout: const Duration(seconds: 70)),
    );
    return MealSuggestionState.fromJson(res.data!);
  }

  Future<List<WeeklyReport>> weeklyReports(String childId) async {
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/ai/weekly-reports',
      queryParameters: {'limit': 10},
    );
    return res.data!
        .map((e) => WeeklyReport.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<bool> weeklyReportEmail() async {
    final res = await _dio.get<Map<String, dynamic>>(
      '/me/notification-settings',
    );
    return res.data!['weeklyReportEmail'] as bool;
  }

  Future<bool> setWeeklyReportEmail(bool enabled) async {
    final res = await _dio.patch<Map<String, dynamic>>(
      '/me/notification-settings',
      data: {'weeklyReportEmail': enabled},
    );
    return res.data!['weeklyReportEmail'] as bool;
  }
}

final aiRepositoryProvider = Provider<AiRepository>(
  (ref) => AiRepository(ref.watch(dioProvider)),
);

final mealSuggestionProvider = FutureProvider.autoDispose
    .family<MealSuggestionState, String>(
      (ref, childId) =>
          ref.watch(aiRepositoryProvider).latestMealSuggestion(childId),
    );

final weeklyReportsProvider = FutureProvider.autoDispose
    .family<List<WeeklyReport>, String>(
      (ref, childId) => ref.watch(aiRepositoryProvider).weeklyReports(childId),
    );

/// 習慣レポートのメール通知を受け取るか（タブを閉じると破棄され、開くたびに取り直す）
final weeklyReportEmailProvider = FutureProvider.autoDispose<bool>(
  (ref) => ref.watch(aiRepositoryProvider).weeklyReportEmail(),
);

/// AI 機能のエラーを画面向けの文言にする
String aiErrorMessage(Object error) {
  if (error is DioException) {
    final data = error.response?.data;
    final code = data is Map ? data['code'] : null;
    switch (error.response?.statusCode) {
      case 422 when code == 'NO_MEAL_RECORDS':
        return '直近 1 か月の食事の記録がありません。食事を記録すると提案できます';
      case 429 when code == 'DAILY_LIMIT':
        return '今日の提案の回数を使い切りました。また明日お試しください';
      case 502:
        return 'AI の応答を受け取れませんでした。少し時間をおいて再度お試しください';
      case 503 when code == 'AI_BUSY':
        return 'AI の利用が混み合っています。時間をおいて再度お試しください';
      case 503:
        return 'AI 機能は現在利用できません';
    }
    if (error.type == DioExceptionType.receiveTimeout) {
      return 'AI の応答に時間がかかっています。少し時間をおいて再度お試しください';
    }
  }
  return errorMessage(error);
}
