import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import 'insights.dart';

class InsightsRepository {
  InsightsRepository(this._dio);

  final Dio _dio;

  Future<MealSuggestionState> latestSuggestion(String childId) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '/children/$childId/meal-suggestions/latest',
    );
    return MealSuggestionState.fromJson(res.data!);
  }

  /// Claude が考えるので数十秒かかることがある
  Future<MealSuggestionState> suggest(String childId) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/children/$childId/meal-suggestions',
      options: Options(receiveTimeout: const Duration(seconds: 70)),
    );
    return MealSuggestionState.fromJson(res.data!);
  }

  Future<List<WeeklyReportSummary>> reports(String childId) async {
    final res = await _dio.get<List<dynamic>>(
      '/children/$childId/weekly-reports',
    );
    return res.data!
        .map((e) => WeeklyReportSummary.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<WeeklyReport> report(String childId, String reportId) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '/children/$childId/weekly-reports/$reportId',
    );
    return WeeklyReport.fromJson(res.data!);
  }
}

final insightsRepositoryProvider = Provider<InsightsRepository>(
  (ref) => InsightsRepository(ref.watch(dioProvider)),
);

final mealSuggestionProvider = FutureProvider.autoDispose
    .family<MealSuggestionState, String>(
      (ref, childId) =>
          ref.watch(insightsRepositoryProvider).latestSuggestion(childId),
    );

final weeklyReportsProvider = FutureProvider.autoDispose
    .family<List<WeeklyReportSummary>, String>(
      (ref, childId) => ref.watch(insightsRepositoryProvider).reports(childId),
    );

final weeklyReportProvider = FutureProvider.autoDispose
    .family<WeeklyReport, ({String childId, String reportId})>(
      (ref, arg) => ref
          .watch(insightsRepositoryProvider)
          .report(arg.childId, arg.reportId),
    );
