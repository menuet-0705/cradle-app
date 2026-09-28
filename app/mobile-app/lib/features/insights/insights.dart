List<String> _strings(Object? v) =>
    (v as List<dynamic>? ?? const []).map((e) => e as String).toList();

class MealIdea {
  const MealIdea({
    required this.title,
    required this.foods,
    required this.reason,
    required this.nutrients,
    required this.tips,
  });

  factory MealIdea.fromJson(Map<String, dynamic> json) => MealIdea(
    title: json['title'] as String,
    foods: _strings(json['foods']),
    reason: json['reason'] as String,
    nutrients: _strings(json['nutrients']),
    tips: json['tips'] as String,
  );

  final String title;
  final List<String> foods;
  final String reason;
  final List<String> nutrients;
  final String tips;
}

class MealSuggestion {
  const MealSuggestion({
    required this.id,
    required this.summary,
    required this.ideas,
    required this.cautions,
    required this.createdAt,
    this.createdByName,
  });

  factory MealSuggestion.fromJson(Map<String, dynamic> json) {
    final content = json['content'] as Map<String, dynamic>;
    return MealSuggestion(
      id: json['id'] as String,
      summary: content['summary'] as String,
      ideas: (content['suggestions'] as List<dynamic>)
          .map((e) => MealIdea.fromJson(e as Map<String, dynamic>))
          .toList(),
      cautions: _strings(content['cautions']),
      createdAt: DateTime.parse(json['createdAt'] as String).toLocal(),
      createdByName:
          (json['createdBy'] as Map<String, dynamic>?)?['name'] as String?,
    );
  }

  final String id;
  final String summary;
  final List<MealIdea> ideas;
  final List<String> cautions;
  final DateTime createdAt;
  final String? createdByName;
}

/// 最新の提案と、今日あと何回提案してもらえるか
class MealSuggestionState {
  const MealSuggestionState({
    this.suggestion,
    required this.remainingToday,
    required this.limitPerDay,
  });

  factory MealSuggestionState.fromJson(Map<String, dynamic> json) =>
      MealSuggestionState(
        suggestion: json['suggestion'] == null
            ? null
            : MealSuggestion.fromJson(
                json['suggestion'] as Map<String, dynamic>,
              ),
        remainingToday: json['remainingToday'] as int,
        limitPerDay: json['limitPerDay'] as int? ?? 3,
      );

  final MealSuggestion? suggestion;
  final int remainingToday;
  final int limitPerDay;
}

enum ReportStatus { pending, ready, failed }

ReportStatus _status(Object? v) => switch (v) {
  'READY' => ReportStatus.ready,
  'FAILED' => ReportStatus.failed,
  _ => ReportStatus.pending,
};

class WeeklyReportSummary {
  const WeeklyReportSummary({
    required this.id,
    required this.periodStart,
    required this.periodEnd,
    required this.status,
    this.headline,
  });

  factory WeeklyReportSummary.fromJson(Map<String, dynamic> json) =>
      WeeklyReportSummary(
        id: json['id'] as String,
        periodStart: DateTime.parse(json['periodStart'] as String).toLocal(),
        periodEnd: DateTime.parse(json['periodEnd'] as String).toLocal(),
        status: _status(json['status']),
        headline: json['headline'] as String?,
      );

  final String id;
  final DateTime periodStart;
  final DateTime periodEnd;
  final ReportStatus status;
  final String? headline;
}

class WeeklyReport {
  const WeeklyReport({
    required this.summary,
    required this.goodPoints,
    required this.concerns,
    required this.trends,
    required this.nextWeekTips,
    required this.consultDoctor,
    required this.consultReason,
  });

  factory WeeklyReport.fromJson(Map<String, dynamic> json) {
    final content = json['content'] as Map<String, dynamic>? ?? const {};
    return WeeklyReport(
      summary: WeeklyReportSummary.fromJson({
        ...json,
        'headline': content['headline'],
      }),
      goodPoints: _strings(content['goodPoints']),
      concerns: _strings(content['concerns']),
      trends: _strings(content['trends']),
      nextWeekTips: _strings(content['nextWeekTips']),
      consultDoctor: content['consultDoctor'] as bool? ?? false,
      consultReason: content['consultReason'] as String? ?? '',
    );
  }

  final WeeklyReportSummary summary;
  final List<String> goodPoints;
  final List<String> concerns;
  final List<String> trends;
  final List<String> nextWeekTips;
  final bool consultDoctor;
  final String consultReason;
}
