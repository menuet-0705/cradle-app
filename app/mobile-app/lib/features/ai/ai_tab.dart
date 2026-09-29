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
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          const _Disclaimer(),
          const SizedBox(height: 16),
          _MealSuggestionSection(childId: childId),
          const SizedBox(height: 16),
          _WeeklyReportsSection(childId: childId),
          const SizedBox(height: 16),
          const _NotificationSetting(),
        ],
      ),
    );
  }
}

// 意味を持たせた色（よかった点・気になる点・傾向など）。
// テーマの明暗に合わせて作るので、ダークモードでも文字と背景の差が保たれる
const _green = Color(0xFF43A047);
const _orange = Color(0xFFFB8C00);
const _blue = Color(0xFF1E88E5);
const _pink = Color(0xFFE91E63);

// 色の計算は軽くないので、(色, 明暗) ごとに一度だけ作って使い回す。
// アプリのテーマの細かな設定（contrastLevel など）はここには反映されない
final _tones = <(Color, Brightness), ColorScheme>{};

ColorScheme _tone(BuildContext context, Color seed) {
  final brightness = Theme.of(context).brightness;
  return _tones[(seed, brightness)] ??= ColorScheme.fromSeed(
    seedColor: seed,
    brightness: brightness,
  );
}

/// 読み物として読みやすい本文（行間を広げる）
TextStyle? _body(BuildContext context) =>
    Theme.of(context).textTheme.bodyMedium?.copyWith(height: 1.6);

class _Disclaimer extends StatelessWidget {
  const _Disclaimer();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(Icons.info_outline, size: 18, color: scheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'AI による参考情報です。体調の心配は医師・保健師に相談してください。',
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
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
    return _SectionCard(
      icon: Icons.restaurant_menu,
      title: '食事の提案',
      subtitle: '過去 1 か月の食事の記録から、好きそうなもの・不足しがちな栄養を補う「次の食事」を提案します',
      child: state.when(
        loading: () => const _Loading(),
        error: (e, _) => Text(errorMessage(e)),
        data: (s) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (s.suggestion case final suggestion?) ...[
              _MealSuggestionView(suggestion: suggestion),
              const SizedBox(height: 16),
            ],
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
    final pink = _tone(context, _pink);
    final orange = _tone(context, _orange);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Caption(
          icon: Icons.schedule,
          text: '${DateFormat('M/d HH:mm').format(suggestion.createdAt)} の提案',
        ),
        if (suggestion.preferences.isNotEmpty) ...[
          const SizedBox(height: 16),
          const _SubHeading(icon: Icons.favorite_border, text: '好みの傾向'),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final p in suggestion.preferences)
                _Tag(p, icon: Icons.favorite, tone: pink),
            ],
          ),
        ],
        if (suggestion.possiblyLacking.isNotEmpty) ...[
          const SizedBox(height: 16),
          _Callout(
            tone: orange,
            icon: Icons.warning_amber_rounded,
            title: '不足気味かもしれない栄養',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final (i, n) in suggestion.possiblyLacking.indexed) ...[
                  if (i > 0) const SizedBox(height: 12),
                  _Tag(n.nutrient, tone: orange, strong: true),
                  const SizedBox(height: 4),
                  Text(n.reason, style: _body(context)),
                ],
              ],
            ),
          ),
        ],
        if (suggestion.suggestions.isNotEmpty) ...[
          const SizedBox(height: 16),
          const _SubHeading(icon: Icons.lightbulb_outline, text: '次の食事のアイデア'),
          const SizedBox(height: 8),
          for (final (i, idea) in suggestion.suggestions.indexed)
            _MealIdeaCard(number: i + 1, idea: idea),
        ],
      ],
    );
  }
}

/// 提案 1 件: 番号・料理名・理由・栄養のタグ・注意事項
class _MealIdeaCard extends StatelessWidget {
  const _MealIdeaCard({required this.number, required this.idea});

  final int number;
  final MealIdea idea;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final green = _tone(context, _green);
    final orange = _tone(context, _orange);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 14,
                backgroundColor: scheme.primary,
                child: Text(
                  '$number',
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: scheme.onPrimary,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  idea.dish,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(idea.reason, style: _body(context)),
          if (idea.nutrients.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final n in idea.nutrients)
                  _Tag(n, icon: Icons.eco_outlined, tone: green),
              ],
            ),
          ],
          if (idea.caution.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: orange.primaryContainer,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.report_gmailerrorred,
                    size: 18,
                    color: orange.onPrimaryContainer,
                    semanticLabel: '注意',
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      idea.caution,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: orange.onPrimaryContainer,
                        height: 1.5,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _WeeklyReportsSection extends ConsumerWidget {
  const _WeeklyReportsSection({required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return _SectionCard(
      icon: Icons.insights,
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
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final r = report;
    final sleepH = r.sleepAvgMinutesPerDay ~/ 60;
    final sleepM = r.sleepAvgMinutesPerDay % 60;
    final weight = r.weightChangeG;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: BorderSide(color: scheme.outlineVariant),
    );
    // Card（Material）で包み、見出しを押したときの反応が背景に隠れないようにする
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      elevation: 0,
      color: scheme.surfaceContainerLow,
      shape: shape,
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        initiallyExpanded: initiallyExpanded,
        shape: const Border(),
        collapsedShape: const Border(),
        title: Text(
          r.headline,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.bold,
            height: 1.4,
          ),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 4),
          child: _Caption(
            icon: Icons.calendar_today_outlined,
            text:
                '${_date.format(r.periodStart)} 〜 ${_date.format(r.periodEnd)}',
          ),
        ),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: [
          _StatGrid(
            tiles: [
              _StatTile(
                icon: Icons.local_drink_outlined,
                value: '${r.milkAvgMlPerDay} ml',
                label: '1日平均のミルク',
              ),
              _StatTile(
                icon: Icons.bedtime_outlined,
                value: '$sleepH時間$sleepM分',
                label: '1日平均の睡眠',
              ),
              _StatTile(
                icon: Icons.restaurant_outlined,
                value: '${r.mealCount} 回',
                label: '食事の記録',
              ),
              if (weight != null)
                _StatTile(
                  icon: weight >= 0 ? Icons.trending_up : Icons.trending_down,
                  value: '${weight >= 0 ? '+' : ''}$weight g',
                  label: '体重の増減',
                ),
            ],
          ),
          if (r.goodPoints.isNotEmpty) ...[
            const SizedBox(height: 16),
            _PointsCallout(
              seed: _green,
              icon: Icons.thumb_up_alt_outlined,
              itemIcon: Icons.check_circle_outline,
              title: 'よかった点',
              items: r.goodPoints,
            ),
          ],
          if (r.concerns.isNotEmpty) ...[
            const SizedBox(height: 12),
            _PointsCallout(
              seed: _orange,
              icon: Icons.warning_amber_rounded,
              itemIcon: Icons.error_outline,
              title: '気になる点',
              items: r.concerns,
            ),
          ],
          if (r.trends.isNotEmpty) ...[
            const SizedBox(height: 12),
            _PointsCallout(
              seed: _blue,
              icon: Icons.show_chart,
              itemIcon: Icons.arrow_right_alt,
              title: '傾向',
              items: r.trends,
            ),
          ],
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
      contentPadding: const EdgeInsets.symmetric(horizontal: 4),
      secondary: const Icon(Icons.mail_outline),
      title: const Text('レポートができたらメールで知らせる'),
      subtitle: const Text('家族のこどものレポートを、原則 1 通にまとめてお知らせします'),
      value: enabled.value ?? false,
      onChanged: enabled.hasValue && !_saving ? _set : null,
    );
  }
}

/// セクション全体の枠。見出しにアイコンと色帯を付ける
class _SectionCard extends StatelessWidget {
  const _SectionCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    // 影は付けず、薄い枠線で区切る
    return Card(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: scheme.surface,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            color: scheme.primaryContainer,
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(
                  radius: 18,
                  backgroundColor: scheme.primary,
                  child: Icon(icon, size: 20, color: scheme.onPrimary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: theme.textTheme.titleMedium?.copyWith(
                          color: scheme.onPrimaryContainer,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: scheme.onPrimaryContainer,
                          height: 1.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(padding: const EdgeInsets.all(16), child: child),
        ],
      ),
    );
  }
}

/// 小見出し（アイコン付き）
class _SubHeading extends StatelessWidget {
  const _SubHeading({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: theme.colorScheme.primary),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            text,
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.bold,
            ),
          ),
        ),
      ],
    );
  }
}

/// 日時・期間などの小さな補足（アイコン付き）
class _Caption extends StatelessWidget {
  const _Caption({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = theme.colorScheme.onSurfaceVariant;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 14, color: color),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(color: color),
          ),
        ),
      ],
    );
  }
}

/// 角丸のタグ。長い文でも折り返す
class _Tag extends StatelessWidget {
  const _Tag(this.label, {required this.tone, this.icon, this.strong = false});

  final String label;
  final ColorScheme tone;
  final IconData? icon;

  /// 濃い色で目立たせる（栄養素名など）
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final background = strong ? tone.primary : tone.secondaryContainer;
    final foreground = strong ? tone.onPrimary : tone.onSecondaryContainer;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 14, color: foreground),
            const SizedBox(width: 4),
          ],
          Flexible(
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelMedium?.copyWith(
                color: foreground,
                fontWeight: strong ? FontWeight.bold : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 色付きの囲み。左端に色の線を付け、見出しと中身を並べる
class _Callout extends StatelessWidget {
  const _Callout({
    required this.tone,
    required this.icon,
    required this.title,
    required this.child,
  });

  final ColorScheme tone;
  final IconData icon;
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 14),
        decoration: BoxDecoration(
          // 種類ごとの色がわかる程度に薄く色を付ける（本文は通常の文字色のまま読める濃さ）
          color: Color.alphaBlend(
            tone.primaryContainer.withValues(alpha: 0.45),
            Theme.of(context).colorScheme.surface,
          ),
          border: Border(left: BorderSide(color: tone.primary, width: 4)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 20, color: tone.primary),
                const SizedBox(width: 6),
                Flexible(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      color: tone.primary,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            child,
          ],
        ),
      ),
    );
  }
}

/// よかった点・気になる点・傾向: 色分けした囲みに、項目ごとのアイコン付きの行
class _PointsCallout extends StatelessWidget {
  const _PointsCallout({
    required this.seed,
    required this.icon,
    required this.itemIcon,
    required this.title,
    required this.items,
  });

  final Color seed;
  final IconData icon;
  final IconData itemIcon;
  final String title;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    final tone = _tone(context, seed);
    return _Callout(
      tone: tone,
      icon: icon,
      title: title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (i, item) in items.indexed) ...[
            if (i > 0) const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Icon(itemIcon, size: 16, color: tone.primary),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(item, style: _body(context))),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// 集計のタイルを 2 列に並べる。同じ行のタイルは高さをそろえる
class _StatGrid extends StatelessWidget {
  const _StatGrid({required this.tiles});

  final List<Widget> tiles;

  static const _gap = 8.0;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < tiles.length; i += 2) ...[
          if (i > 0) const SizedBox(height: _gap),
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: tiles[i]),
                const SizedBox(width: _gap),
                Expanded(
                  child: i + 1 < tiles.length
                      ? tiles[i + 1]
                      : const SizedBox.shrink(),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.icon,
    required this.value,
    required this.label,
  });

  final IconData icon;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      // ラベルを上に小さく、数値を下に大きく（幅の狭い 2 列でも折り返しにくい）
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Icon(icon, size: 16, color: scheme.onSecondaryContainer),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  label,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onSecondaryContainer,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          // 数値は折り返さず、幅が足りなければ縮めて 1 行に収める
          // （文字を大きくする設定でも、タイルの幅を超える分は縮む。はみ出しより読みやすさを優先）
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              maxLines: 1,
              style: theme.textTheme.titleLarge?.copyWith(
                color: scheme.onSecondaryContainer,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => const Padding(
    padding: EdgeInsets.all(24),
    child: Center(child: CircularProgressIndicator()),
  );
}
