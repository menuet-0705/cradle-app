import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'ai_models.dart';
import 'ai_providers.dart';

/// 「AIによる分析」タブ: 食事の提案・習慣レポート・通知設定
class AiTab extends ConsumerWidget {
  const AiTab({super.key, required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () => Future.wait([
        ref.refresh(mealSuggestionProvider(childId).future),
        ref.refresh(weeklyReportsProvider(childId).future),
      ]),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const _Disclaimer(),
          const SizedBox(height: 16),
          _MealSuggestionSection(childId: childId),
          const SizedBox(height: 24),
          _WeeklyReportsSection(childId: childId),
          const SizedBox(height: 24),
          const _NotificationSetting(),
        ],
      ),
    );
  }
}

class _Disclaimer extends StatelessWidget {
  const _Disclaimer();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.info_outline, size: 18, color: theme.colorScheme.outline),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            'AI による参考情報です。体調の心配は医師・保健師に相談してください。',
            style: theme.textTheme.bodySmall,
          ),
        ),
      ],
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
  bool _generating = false;
  String? _error;

  Future<void> _generate() async {
    setState(() {
      _generating = true;
      _error = null;
    });
    try {
      await ref.read(aiRepositoryProvider).createMealSuggestion(widget.childId);
      ref.invalidate(mealSuggestionProvider(widget.childId));
    } catch (e) {
      if (mounted) setState(() => _error = aiErrorMessage(e));
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mealSuggestionProvider(widget.childId));
    return _Section(
      title: '食事の提案',
      subtitle: '過去 1 か月の食事の記録から、好きそうなもの・不足しがちな栄養を補う「次の食事」を提案します',
      child: state.when(
        loading: () => const _Loading(),
        error: (e, _) => Text(errorMessage(e)),
        data: (s) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (s.suggestion case final suggestion?)
              _MealSuggestionView(suggestion: suggestion),
            const SizedBox(height: 12),
            if (_generating)
              const Column(
                children: [
                  CircularProgressIndicator(),
                  SizedBox(height: 8),
                  Text('提案を考えています…（数十秒かかることがあります）'),
                ],
              )
            else ...[
              FilledButton.icon(
                onPressed: s.enabled && s.remainingToday > 0 ? _generate : null,
                icon: const Icon(Icons.auto_awesome),
                label: Text(s.suggestion == null ? '提案してもらう' : 'もう一度提案してもらう'),
              ),
              const SizedBox(height: 4),
              Text(
                s.enabled
                    ? '今日はあと ${s.remainingToday} 回提案できます'
                    : 'AI 機能は現在利用できません',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            if (_error case final error?) ...[
              const SizedBox(height: 8),
              Text(
                error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _MealSuggestionView extends StatelessWidget {
  const _MealSuggestionView({required this.suggestion});

  final MealSuggestion suggestion;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${DateFormat('M/d HH:mm').format(suggestion.createdAt)} の提案',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        _Bullets(title: '好みの傾向', items: suggestion.preferences),
        if (suggestion.possiblyLacking.isNotEmpty)
          _Bullets(
            title: '不足気味かもしれない栄養',
            items: [
              for (final n in suggestion.possiblyLacking)
                '${n.nutrient}: ${n.reason}',
            ],
          ),
        const SizedBox(height: 8),
        for (final idea in suggestion.suggestions)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(idea.dish, style: theme.textTheme.titleSmall),
                  const SizedBox(height: 4),
                  Text(idea.reason),
                  if (idea.nutrients.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final n in idea.nutrients)
                          Chip(
                            label: Text(n),
                            visualDensity: VisualDensity.compact,
                          ),
                      ],
                    ),
                  ],
                  if (idea.caution.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      '注意: ${idea.caution}',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _WeeklyReportsSection extends ConsumerWidget {
  const _WeeklyReportsSection({required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _Section(
      title: '習慣レポート',
      subtitle: '毎週金曜の夕方に、1 週間の記録をふりかえるレポートが作られます',
      child: ref
          .watch(weeklyReportsProvider(childId))
          .when(
            loading: () => const _Loading(),
            error: (e, _) => Text(errorMessage(e)),
            data: (reports) => reports.isEmpty
                ? const Text('まだレポートはありません。記録をつけると、金曜の夕方にレポートが作られます')
                : Column(
                    children: [
                      for (final (i, r) in reports.indexed)
                        _WeeklyReportTile(report: r, initiallyExpanded: i == 0),
                    ],
                  ),
          ),
    );
  }
}

class _WeeklyReportTile extends StatelessWidget {
  const _WeeklyReportTile({
    required this.report,
    required this.initiallyExpanded,
  });

  final WeeklyReport report;
  final bool initiallyExpanded;

  static final _date = DateFormat('M/d');

  @override
  Widget build(BuildContext context) {
    final r = report;
    final sleepH = r.sleepAvgMinutesPerDay ~/ 60;
    final sleepM = r.sleepAvgMinutesPerDay % 60;
    final weight = r.weightChangeG;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        initiallyExpanded: initiallyExpanded,
        title: Text(r.headline),
        subtitle: Text(
          '${_date.format(r.periodStart)} 〜 ${_date.format(r.periodEnd)}',
        ),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: [
              _Stat('ミルク 1 日平均 ${r.milkAvgMlPerDay} ml'),
              _Stat('睡眠 1 日平均 $sleepH時間$sleepM分'),
              _Stat('食事 ${r.mealCount} 回'),
              if (weight != null)
                _Stat('体重 ${weight >= 0 ? '+' : ''}$weight g'),
            ],
          ),
          const SizedBox(height: 8),
          _Bullets(title: 'よかった点', items: r.goodPoints),
          if (r.concerns.isNotEmpty)
            _Bullets(title: '気になる点', items: r.concerns),
          _Bullets(title: '傾向', items: r.trends),
        ],
      ),
    );
  }
}

class _NotificationSetting extends ConsumerStatefulWidget {
  const _NotificationSetting();

  @override
  ConsumerState<_NotificationSetting> createState() =>
      _NotificationSettingState();
}

class _NotificationSettingState extends ConsumerState<_NotificationSetting> {
  bool _saving = false;

  Future<void> _set(bool enabled) async {
    setState(() => _saving = true);
    try {
      await ref.read(aiRepositoryProvider).setWeeklyReportEmail(enabled);
      ref.invalidate(weeklyReportEmailProvider);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(errorMessage(e))));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enabled = ref.watch(weeklyReportEmailProvider);
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: const Text('レポートができたらメールで知らせる'),
      subtitle: const Text('家族のこどものレポートを、原則 1 通にまとめてお知らせします'),
      value: enabled.value ?? false,
      onChanged: enabled.hasValue && !_saving ? _set : null,
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final String title;
  final String subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(title, style: theme.textTheme.titleMedium),
        const SizedBox(height: 4),
        Text(subtitle, style: theme.textTheme.bodySmall),
        const SizedBox(height: 12),
        child,
      ],
    );
  }
}

class _Bullets extends StatelessWidget {
  const _Bullets({required this.title, required this.items});

  final String title;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 2),
          for (final item in items) Text('・$item'),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label);

  final String label;

  @override
  Widget build(BuildContext context) =>
      Chip(label: Text(label), visualDensity: VisualDensity.compact);
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(24),
    child: Center(child: CircularProgressIndicator()),
  );
}
