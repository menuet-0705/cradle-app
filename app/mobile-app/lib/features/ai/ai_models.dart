List<String> _strings(Object? v) =>
    (v as List<dynamic>? ?? const []).cast<String>();

class LackingNutrient {
  const LackingNutrient({required this.nutrient, required this.reason});

  factory LackingNutrient.fromJson(Map<String, dynamic> json) =>
      LackingNutrient(
        nutrient: json['nutrient'] as String,
        reason: json['reason'] as String,
      );

  final String nutrient;
  final String reason;
}

class MealIdea {
  const MealIdea({
    required this.dish,
    required this.reason,
    required this.nutrients,
    required this.caution,
  });

  factory MealIdea.fromJson(Map<String, dynamic> json) => MealIdea(
    dish: json['dish'] as String,
    reason: json['reason'] as String,
    nutrients: _strings(json['nutrients']),
    caution: json['caution'] as String? ?? '',
  );

  final String dish;
  final String reason;
  final List<String> nutrients;
  final String caution;
}

/// AI による食事の提案
class MealSuggestion {
  const MealSuggestion({
    required this.id,
    required this.createdAt,
    required this.preferences,
    required this.possiblyLacking,
    required this.suggestions,
  });

  factory MealSuggestion.fromJson(Map<String, dynamic> json) {
    final content = json['content'] as Map<String, dynamic>;
    return MealSuggestion(
      id: json['id'] as String,
      createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      preferences: _strings(content['preferences']),
      possiblyLacking: (content['possiblyLacking'] as List<dynamic>? ?? [])
          .map((e) => LackingNutrient.fromJson(e as Map<String, dynamic>))
          .toList(),
      suggestions: (content['suggestions'] as List<dynamic>? ?? [])
          .map((e) => MealIdea.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  final String id;
  final DateTime createdAt;
  final List<String> preferences;
  final List<LackingNutrient> possiblyLacking;
  final List<MealIdea> suggestions;
}

/// 直近の提案と、今日あと何回提案できるか
class MealSuggestionState {
  const MealSuggestionState({
    required this.suggestion,
    required this.remainingToday,
    required this.enabled,
  });

  factory MealSuggestionState.fromJson(Map<String, dynamic> json) {
    final s = json['suggestion'] as Map<String, dynamic>?;
    return MealSuggestionState(
      suggestion: s == null ? null : MealSuggestion.fromJson(s),
      remainingToday: json['remainingToday'] as int,
      enabled: json['enabled'] as bool? ?? true,
    );
  }

  final MealSuggestion? suggestion;
  final int remainingToday;

  /// サーバーで AI が設定されているか
  final bool enabled;
}

/// AI による 1 週間の習慣レポート
class WeeklyReport {
  const WeeklyReport({
    required this.id,
    required this.periodStart,
    required this.periodEnd,
    required this.headline,
    required this.goodPoints,
    required this.concerns,
    required this.trends,
    required this.milkAvgMlPerDay,
    required this.sleepAvgMinutesPerDay,
    required this.mealCount,
    required this.weightChangeG,
  });

  factory WeeklyReport.fromJson(Map<String, dynamic> json) {
    final content = json['content'] as Map<String, dynamic>;
    final summary = json['summary'] as Map<String, dynamic>;
    final weight = summary['weight'] as Map<String, dynamic>?;
    return WeeklyReport(
      id: json['id'] as String,
      periodStart: DateTime.parse(json['periodStart'] as String).toLocal(),
      periodEnd: DateTime.parse(json['periodEnd'] as String).toLocal(),
      headline: content['headline'] as String,
      goodPoints: _strings(content['goodPoints']),
      concerns: _strings(content['concerns']),
      trends: _strings(content['trends']),
      milkAvgMlPerDay:
          (summary['milk'] as Map<String, dynamic>)['avgMlPerDay'] as int,
      sleepAvgMinutesPerDay:
          (summary['sleep'] as Map<String, dynamic>)['avgMinutesPerDay'] as int,
      mealCount: (summary['meals'] as Map<String, dynamic>)['count'] as int,
      weightChangeG: weight?['changeG'] as int?,
    );
  }

  final String id;
  final DateTime periodStart;
  final DateTime periodEnd;
  final String headline;
  final List<String> goodPoints;
  final List<String> concerns;
  final List<String> trends;
  final int milkAvgMlPerDay;
  final int sleepAvgMinutesPerDay;
  final int mealCount;

  /// 期間内の体重の増減（g）。記録が 1 件もなければ null
  final int? weightChangeG;
}
