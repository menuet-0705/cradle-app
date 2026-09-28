import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../families/families_providers.dart';
import 'ai_consent.dart';
import 'insights.dart';
import 'insights_providers.dart';

/// 画面に常に出す注意書き（AI の出力は医療上の助言ではない）
const aiDisclaimer =
    'AI（Claude）が記録をもとに作成した一般的な情報です。医療上の助言ではありません。'
    '気になることは、かかりつけ医や保健師に相談してください。';

/// 同意した管理者以外のメンバーにも、記録が AI に送られていることを知らせる
const aiEnabledNotice =
    'この家族では、管理者の同意により AI 機能が有効です。記録（食事のメモを含む）は Anthropic 社（米国）に送られます。'
    '家族の画面で管理者がオフにできます。';

String insightsErrorMessage(Object e) {
  if (e is DioException) {
    final data = e.response?.data;
    switch (data is Map ? data['code'] : null) {
      case 'SUGGESTION_LIMIT':
        return '今日の提案の上限に達しました。明日またお試しください';
      case 'AI_CONSENT_REQUIRED':
        return 'AI 機能が有効になっていません。家族の管理者が有効にすると使えます';
      case 'AI_BUSY':
        return '混み合っています。少し時間をおいてお試しください';
      case 'AI_UNAVAILABLE':
        return '提案を作れませんでした。時間をおいてお試しください';
    }
    if (e.type == DioExceptionType.receiveTimeout) {
      return '時間がかかりすぎたため中断しました。もう一度お試しください';
    }
  }
  return errorMessage(e);
}

/// 「ふりかえり」タブ: 次の食事の提案と、週次の習慣レポート。
/// 家族の管理者が AI 機能に同意するまでは、説明と同意の入口だけを出す
class InsightsTab extends ConsumerWidget {
  const InsightsTab({super.key, required this.childId, this.familyId});

  final String childId;
  final String? familyId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final families = ref.watch(familiesProvider);
    return families.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => Center(child: Text(errorMessage(e))),
      data: (list) {
        final family =
            list.where((f) => f.id == familyId).firstOrNull ?? list.firstOrNull;
        if (family == null || !family.aiEnabled) {
          return RefreshIndicator(
            onRefresh: () => ref.refresh(familiesProvider.future),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [if (family != null) AiConsentCard(family: family)],
            ),
          );
        }
        return _InsightsContent(childId: childId);
      },
    );
  }
}

class _InsightsContent extends ConsumerWidget {
  const _InsightsContent({required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () => Future.wait([
        ref.refresh(mealSuggestionProvider(childId).future),
        ref.refresh(weeklyReportsProvider(childId).future),
      ]),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          _MealSuggestionSection(childId: childId),
          const SizedBox(height: 32),
          _WeeklyReportsSection(childId: childId),
          const SizedBox(height: 24),
          for (final note in const [aiDisclaimer, aiEnabledNotice])
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                note,
                style: Theme.of(context).textTheme.bodySmall
                    ?.copyWith(color: Theme.of(context).hintColor),
              ),
            ),
        ],
      ),
    );
  }
}

class _MealSuggestionSection extends ConsumerStatefulWidget {
  const _MealSuggestionSection({required this.childId});

  final String childId;

  @override
  ConsumerState<_MealSuggestionSection> createState() =>
      _MealSuggestionSectionState();
}

class _MealSuggestionSectionState
    extends ConsumerState<_MealSuggestionSection> {
  bool _loading = false;
  String? _error;

  Future<void> _suggest() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await ref.read(insightsRepositoryProvider).suggest(widget.childId);
    } catch (e) {
      if (mounted) setState(() => _error = insightsErrorMessage(e));
      // 同意が取り消されていた場合は、同意の画面に切り替える
      if (e is DioException &&
          (e.response?.data is Map) &&
          (e.response!.data as Map)['code'] == 'AI_CONSENT_REQUIRED') {
        ref.invalidate(familiesProvider);
      }
    } finally {
      // 成功・失敗どちらでも残り回数が変わるので読み直す
      ref.invalidate(mealSuggestionProvider(widget.childId));
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final state = ref.watch(mealSuggestionProvider(widget.childId));
    // 残り回数が取得できないとき（通信エラーなど）はボタンを押せるままにする（上限はサーバーが判定する）
    final remaining = state.value?.remainingToday;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('次の食事の提案', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          'この 1 か月の食事の記録（食べた量・反応）から、好きそうな食材や不足しがちな栄養を補う献立を提案します。',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: _loading || state.isLoading || remaining == 0
              ? null
              : _suggest,
          icon: _loading
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.auto_awesome),
          label: Text(
            _loading ? '考えています…（数十秒かかります）' : '提案してもらう（今日あと $remaining 回）',
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 12),
        state.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Text(errorMessage(e)),
          data: (s) => s.suggestion == null
              ? const SizedBox.shrink()
              : _SuggestionCard(suggestion: s.suggestion!),
        ),
      ],
    );
  }
}

class _SuggestionCard extends StatelessWidget {
  const _SuggestionCard({required this.suggestion});

  final MealSuggestion suggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final by = suggestion.createdByName;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${DateFormat('M月d日 HH:mm', 'ja').format(suggestion.createdAt)}'
              '${by == null ? '' : '・$byさんが依頼'}',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: 8),
            Text(suggestion.summary),
            for (final idea in suggestion.ideas) ...[
              const Divider(height: 24),
              Text(idea.title, style: theme.textTheme.titleSmall),
              const SizedBox(height: 4),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final f in idea.foods)
                    Chip(label: Text(f), visualDensity: VisualDensity.compact),
                ],
              ),
              const SizedBox(height: 4),
              Text(idea.reason),
              if (idea.nutrients.isNotEmpty)
                Text(
                  '補える栄養: ${idea.nutrients.join('・')}',
                  style: theme.textTheme.bodySmall,
                ),
              const SizedBox(height: 4),
              Text('コツ: ${idea.tips}', style: theme.textTheme.bodySmall),
            ],
            if (suggestion.cautions.isNotEmpty) ...[
              const Divider(height: 24),
              Text('注意', style: theme.textTheme.titleSmall),
              for (final c in suggestion.cautions) Text('・$c'),
            ],
          ],
        ),
      ),
    );
  }
}

class _WeeklyReportsSection extends ConsumerWidget {
  const _WeeklyReportsSection({required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final fmt = DateFormat('M/d', 'ja');
    final reports = ref.watch(weeklyReportsProvider(childId));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('週のふりかえり', style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(
          '毎週金曜の夕方に、1 週間の記録からレポートを作ります（家族にメールでもお知らせします）。',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        reports.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => Text(errorMessage(e)),
          data: (list) => list.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Text('まだレポートはありません。記録をつけると、金曜の夕方に届きます。'),
                )
              : Column(
                  children: [
                    for (final r in list)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: Icon(switch (r.status) {
                          ReportStatus.ready => Icons.article_outlined,
                          ReportStatus.pending => Icons.hourglass_top,
                          ReportStatus.failed => Icons.error_outline,
                        }),
                        title: Text(switch (r.status) {
                          ReportStatus.ready => r.headline ?? 'ふりかえり',
                          ReportStatus.pending => '作成中です',
                          ReportStatus.failed => '作成できませんでした',
                        }),
                        subtitle: Text(
                          '${fmt.format(r.periodStart)}〜${fmt.format(r.periodEnd)}',
                        ),
                        trailing: r.status == ReportStatus.ready
                            ? const Icon(Icons.chevron_right)
                            : null,
                        onTap: r.status == ReportStatus.ready
                            ? () => context.push(
                                '/children/$childId/reports/${r.id}',
                              )
                            : null,
                      ),
                  ],
                ),
        ),
      ],
    );
  }
}
