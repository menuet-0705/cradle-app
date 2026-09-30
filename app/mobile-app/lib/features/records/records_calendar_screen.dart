import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../children/children_providers.dart';
import 'daily_summary.dart';
import 'growth_record.dart';
import 'records_providers.dart';

/// さかのぼれる月数（生年月日が分からないとき）。記録画面でさかのぼれる日数（10 年）と揃える
const _maxPastMonths = 120;

/// 前後の月へのページ送り（矢印ボタン）の動き
const _pageDuration = Duration(milliseconds: 300);

/// 1 か月の記録をカレンダーでまとめて見る画面。日付を選んで「この日の記録を見る」を押すと、
/// その日を返して閉じる（記録画面がその日のページへ移る）
class RecordsCalendarScreen extends ConsumerStatefulWidget {
  const RecordsCalendarScreen({
    super.key,
    required this.childId,
    required this.initialMonth,
  });

  final String childId;

  /// 最初に出す月（その月の 1 日）
  final DateTime initialMonth;

  @override
  ConsumerState<RecordsCalendarScreen> createState() =>
      _RecordsCalendarScreenState();
}

class _RecordsCalendarScreenState extends ConsumerState<RecordsCalendarScreen> {
  /// ページ番号の基準の月（ページ番号 = この月から何か月前か）。
  /// 開いたときに決める（開いたまま月をまたいだときは、開き直すまで新しい月へ進めない。まれなので割り切る）
  late final DateTime _thisMonth;
  late final PageController _pages;
  late int _page;
  DateTime? _selected;

  /// 矢印ボタンで動かしている途中の行き先（素早く続けて押したときに、その先へ進めるため）
  int? _animatingTo;

  @override
  void initState() {
    super.initState();
    final now = today();
    _thisMonth = DateTime(now.year, now.month);
    _page = _pageOf(widget.initialMonth).clamp(0, _maxPastMonths);
    _pages = PageController(initialPage: _page, keepPage: false);
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  int _pageOf(DateTime month) =>
      (_thisMonth.year - month.year) * 12 + _thisMonth.month - month.month;

  DateTime _monthOf(int page) =>
      DateTime(_thisMonth.year, _thisMonth.month - page);

  Future<void> _step(int lastPage, int delta) async {
    final target = ((_animatingTo ?? _page) + delta).clamp(0, lastPage);
    _animatingTo = target;
    await _pages.animateToPage(
      target,
      duration: _pageDuration,
      curve: Curves.easeInOut,
    );
    if (_animatingTo == target) _animatingTo = null;
  }

  @override
  Widget build(BuildContext context) {
    final birthDate = ref
        .watch(childrenProvider)
        .value
        ?.where((c) => c.id == widget.childId)
        .firstOrNull
        ?.birthDate;
    // 生まれた月より前には戻らない（生まれた月より前の月から開いた場合も、今のページには居られるようにする）
    final lastPage = birthDate == null
        ? _maxPastMonths
        : _pageOf(DateTime(birthDate.year, birthDate.month))
              .clamp(_page, _maxPastMonths);
    final month = _monthOf(_page);
    // 表示中の月を読み込んでいる間は、見出しの下に細い進捗バーを出す（スクロールしても見えるよう、リストの外に置く）
    final loading = ref
        .watch(monthSummaryProvider((childId: widget.childId, month: month)))
        .isLoading;

    return Scaffold(
      appBar: AppBar(title: const Text('カレンダー')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                IconButton(
                  tooltip: '前の月',
                  icon: const Icon(Icons.chevron_left),
                  onPressed: _page < lastPage ? () => _step(lastPage, 1) : null,
                ),
                Expanded(
                  child: Text(
                    DateFormat('y年M月', 'ja').format(month),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: '次の月',
                  icon: const Icon(Icons.chevron_right),
                  // 今月より先には進めない
                  onPressed: _page > 0 ? () => _step(lastPage, -1) : null,
                ),
              ],
            ),
          ),
          // 高さは常に確保して、表示の切り替えで画面がずれないようにする
          SizedBox(
            height: 4,
            child: loading
                ? const LinearProgressIndicator(semanticsLabel: '読み込み中')
                : const Divider(height: 1),
          ),
          Expanded(
            // reverse: 今月（0 ページ目）が右端。右スワイプで前の月、左スワイプで次の月
            child: PageView.builder(
              controller: _pages,
              reverse: true,
              itemCount: lastPage + 1,
              onPageChanged: (p) => setState(() => _page = p),
              itemBuilder: (_, p) => _MonthPage(
                childId: widget.childId,
                month: _monthOf(p),
                birthDate: birthDate,
                selected: _selected,
                onSelect: (day) => setState(() => _selected = day),
                onOpenDay: (day) => context.pop(day),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 1 か月分（1 ページ）。マスの枠はデータを待たずに出し、読み込み中はそれとわかる表示にする
class _MonthPage extends ConsumerWidget {
  const _MonthPage({
    required this.childId,
    required this.month,
    required this.birthDate,
    required this.selected,
    required this.onSelect,
    required this.onOpenDay,
  });

  final String childId;
  final DateTime month;
  final DateTime? birthDate;
  final DateTime? selected;
  final ValueChanged<DateTime> onSelect;
  final ValueChanged<DateTime> onOpenDay;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = monthSummaryProvider((childId: childId, month: month));
    final async = ref.watch(provider);
    // この月のデータだけを使う（別の月の数字は出さない）。再読み込み中は前の値を出したまま
    final days = async.value;
    final loading = async.isLoading;
    // この月の数字がまだない状態。失敗した月を取り直している間は「読み込み中」として扱う
    final waiting = loading && days == null;
    final failed = !loading && days == null && async.hasError;
    final day = selected;
    final selectedHere =
        day != null && day.year == month.year && day.month == month.month;

    return RefreshIndicator(
      onRefresh: () => ref.refresh(provider.future),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          const _WeekdayRow(),
          _MonthGrid(
            month: month,
            days: days,
            waiting: waiting,
            birthDate: birthDate,
            selected: day,
            onSelect: onSelect,
          ),
          if (async.hasError && !loading)
            _ErrorBox(
              message: errorMessage(async.error!),
              onRetry: () => ref.invalidate(provider),
            ),
          if (selectedHere)
            // マスの下に出るので、小さい画面でも見えるところまでスクロールする
            _ScrollIntoView(
              trigger: day,
              child: _DayDetail(
                day: day,
                summary: days?[day],
                waiting: waiting,
                failed: failed,
                onOpen: () => onOpenDay(day),
              ),
            ),
          _MonthTotalsCard(
            month: month,
            totals: days == null ? null : MonthTotals.of(days.values),
            failed: failed,
          ),
        ],
      ),
    );
  }
}

class _WeekdayRow extends StatelessWidget {
  const _WeekdayRow();

  static const _labels = ['日', '月', '火', '水', '木', '金', '土'];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
      child: Row(
        children: [
          for (final (i, label) in _labels.indexed)
            Expanded(
              child: Text(
                label,
                textAlign: TextAlign.center,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: switch (i) {
                    0 => theme.colorScheme.error,
                    6 => theme.colorScheme.primary,
                    _ => theme.colorScheme.onSurfaceVariant,
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 日曜始まりのマス。[days] が null の間（読み込み中）は、要約の代わりに仮の棒を出す
class _MonthGrid extends StatelessWidget {
  const _MonthGrid({
    required this.month,
    required this.days,
    required this.waiting,
    required this.birthDate,
    required this.selected,
    required this.onSelect,
  });

  final DateTime month;
  final Map<DateTime, DailySummary>? days;
  final bool waiting;
  final DateTime? birthDate;
  final DateTime? selected;
  final ValueChanged<DateTime> onSelect;

  @override
  Widget build(BuildContext context) {
    final daysInMonth = DateUtils.getDaysInMonth(month.year, month.month);
    // DateTime.weekday は月曜 = 1 〜 日曜 = 7。日曜始まりなので 7 で割った余りが先頭の空きマスの数
    final leading = DateTime(month.year, month.month).weekday % 7;
    final rows = ((leading + daysInMonth) / 7).ceil();
    final now = today();

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      // マスは小さいので、文字の拡大はほどほどにしてはみ出さないようにする
      child: MediaQuery.withClampedTextScaling(
        maxScaleFactor: 1.2,
        child: Column(
          children: [
            for (var r = 0; r < rows; r++)
              Row(
                children: [
                  for (var c = 0; c < 7; c++)
                    Expanded(
                      child: _cell(r * 7 + c - leading + 1, daysInMonth, now),
                    ),
                ],
              ),
          ],
        ),
      ),
    );
  }

  /// [d] 日のマス（月の前後の空きマスは空白）
  Widget _cell(int d, int daysInMonth, DateTime now) {
    if (d < 1 || d > daysInMonth) return const SizedBox.shrink();
    final date = DateTime(month.year, month.month, d);
    final born = birthDate == null ? null : DateUtils.dateOnly(birthDate!);
    return _DayCell(
      date: date,
      summary: days?[date],
      waiting: waiting,
      isToday: date == now,
      // 未来の日と生まれる前の日は薄くして選べなくする
      enabled: !date.isAfter(now) && (born == null || !date.isBefore(born)),
      selected: date == selected,
      onTap: () => onSelect(date),
    );
  }
}

class _DayCell extends StatelessWidget {
  const _DayCell({
    required this.date,
    required this.summary,
    required this.waiting,
    required this.isToday,
    required this.enabled,
    required this.selected,
    required this.onTap,
  });

  /// マスの高さ。日付と要約 4 行が、文字を拡大しても（上限 1.2 倍）収まるようにする
  static double heightFor(TextScaler scaler) =>
      // 余白（padding・margin）+ 日付（Material 3 の labelMedium の行の高さ 16 + 余裕 1）+ 間
      // + 要約 4 行（10px × 行の高さ 1.3）。テーマで labelMedium を変えたら合わせて直す
      8 + scaler.scale(17) + 2 + 4 * scaler.scale(10 * 1.3);

  final DateTime date;
  final DailySummary? summary;
  final bool waiting;
  final bool isToday;
  final bool enabled;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final s = summary;
    final lines = s == null ? const <(IconData, String)>[] : _lines(s);

    return Semantics(
      button: enabled,
      selected: selected,
      // 子の読み上げ（InkWell のタップ）は除くので、タップはここで受ける
      onTap: enabled ? onTap : null,
      label: [
        DateFormat('M月d日', 'ja').format(date),
        if (waiting) '読み込み中',
        for (final (_, text) in lines) text,
      ].join(' '),
      excludeSemantics: true,
      child: Opacity(
        opacity: enabled ? 1 : 0.38,
        child: InkWell(
          onTap: enabled ? onTap : null,
          borderRadius: BorderRadius.circular(8),
          child: Container(
            height: heightFor(MediaQuery.textScalerOf(context)),
            margin: const EdgeInsets.all(1),
            padding: const EdgeInsets.fromLTRB(2, 2, 2, 2),
            decoration: BoxDecoration(
              color: selected ? scheme.primaryContainer : null,
              borderRadius: BorderRadius.circular(8),
              border: isToday ? Border.all(color: scheme.primary) : null,
            ),
            child: Column(
              children: [
                Text(
                  '${date.day}',
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: isToday ? FontWeight.bold : null,
                    color: selected ? scheme.onPrimaryContainer : null,
                  ),
                ),
                const SizedBox(height: 2),
                if (waiting && enabled)
                  const _Placeholder()
                else
                  for (final (icon, text) in lines)
                    _CellLine(icon: icon, text: text),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// マスに出す要約（最大 4 行。記録のない種類は出さない）
  static List<(IconData, String)> _lines(DailySummary s) => [
    if (s.milkCount > 0) (RecordType.milk.icon, '${s.milkMl}ml'),
    if (s.sleepCount > 0)
      (RecordType.sleep.icon, '${(s.sleepMinutes / 60).toStringAsFixed(1)}h'),
    if (s.weightG case final g?)
      (RecordType.weight.icon, '${(g / 1000).toStringAsFixed(2)}kg'),
    if (s.mealCount > 0) (RecordType.meal.icon, '${s.mealCount}回'),
  ];
}

class _CellLine extends StatelessWidget {
  const _CellLine({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    // 幅が足りないときは文字を縮めて、はみ出さないようにする
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 10, color: color),
          const SizedBox(width: 1),
          Text(text, style: TextStyle(fontSize: 10, height: 1.3, color: color)),
        ],
      ),
    );
  }
}

/// 読み込み中の仮の棒（マスの要約の場所に出す）。ゆっくり明滅させて、読み込み中だとわかるようにする
/// （端末で「動きを減らす」にしているときは明滅させない）
class _Placeholder extends StatefulWidget {
  const _Placeholder();

  @override
  State<_Placeholder> createState() => _PlaceholderState();
}

class _PlaceholderState extends State<_Placeholder>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
    lowerBound: 0.4,
    value: 1,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.maybeDisableAnimationsOf(context) ?? false) {
      _controller
        ..stop()
        ..value = 1;
    } else if (!_controller.isAnimating) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;
    Widget bar(double widthFactor) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: FractionallySizedBox(
        widthFactor: widthFactor,
        child: Container(
          height: 8,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(4),
          ),
        ),
      ),
    );
    return FadeTransition(
      opacity: _controller,
      child: Column(children: [bar(0.8), bar(0.6)]),
    );
  }
}

class _ErrorBox extends StatelessWidget {
  const _ErrorBox({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
      child: Column(
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 8),
          OutlinedButton(onPressed: onRetry, child: const Text('再読み込み')),
        ],
      ),
    );
  }
}

/// 出たとき・[trigger] が変わったときに、[child] が見えるところまでスクロールする
class _ScrollIntoView extends StatefulWidget {
  const _ScrollIntoView({required this.trigger, required this.child});

  final Object trigger;
  final Widget child;

  @override
  State<_ScrollIntoView> createState() => _ScrollIntoViewState();
}

class _ScrollIntoViewState extends State<_ScrollIntoView> {
  @override
  void initState() {
    super.initState();
    _reveal();
  }

  @override
  void didUpdateWidget(_ScrollIntoView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.trigger != widget.trigger) _reveal();
  }

  // 配置が決まってから（描画の後で）スクロールする
  void _reveal() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!mounted) return;
    Scrollable.ensureVisible(
      context,
      duration: const Duration(milliseconds: 250),
      curve: Curves.easeOut,
      alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
    );
  });

  @override
  Widget build(BuildContext context) => widget.child;
}

/// 選んだ日の要約と、記録画面のその日へ移るボタン
class _DayDetail extends StatelessWidget {
  const _DayDetail({
    required this.day,
    required this.summary,
    required this.waiting,
    required this.failed,
    required this.onOpen,
  });

  final DateTime day;
  final DailySummary? summary;
  final bool waiting;

  /// 月の取得に失敗した（要約が分からない）
  final bool failed;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = summary;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              DateFormat('M月d日(E)', 'ja').format(day),
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (waiting)
              const Text('読み込み中…')
            else if (failed)
              const Text('読み込めませんでした')
            else if (s == null)
              const Text('この日の記録はありません')
            else ...[
              if (s.milkCount > 0)
                _row(RecordType.milk, '${s.milkCount}回 · 合計 ${s.milkMl} ml'),
              if (s.sleepCount > 0)
                _row(
                  RecordType.sleep,
                  '${s.sleepCount}回 · 合計 '
                  '${GrowthRecord.formatDuration(Duration(minutes: s.sleepMinutes))}',
                ),
              if (s.weightG case final g?)
                _row(RecordType.weight, '${(g / 1000).toStringAsFixed(2)} kg'),
              if (s.mealCount > 0) _row(RecordType.meal, '${s.mealCount}回'),
            ],
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.tonal(
                onPressed: onOpen,
                child: const Text('この日の記録を見る'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(RecordType type, String text) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      children: [
        Icon(type.icon, size: 18),
        const SizedBox(width: 8),
        Text('${type.label}  '),
        Expanded(child: Text(text)),
      ],
    ),
  );
}

/// 月のまとめ
class _MonthTotalsCard extends StatelessWidget {
  const _MonthTotalsCard({
    required this.month,
    required this.totals,
    required this.failed,
  });

  final DateTime month;
  final MonthTotals? totals;

  /// 月の取得に失敗した
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final t = totals;
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${DateFormat('M月', 'ja').format(month)}のまとめ',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            if (t == null)
              Text(failed ? '読み込めませんでした' : '読み込み中…')
            else if (t.recordedDays == 0)
              const Text('この月の記録はまだありません')
            else ...[
              _row('記録した日', '${t.recordedDays}日'),
              if (t.milkAvgMl case final ml?) _row('ミルク', '1日平均 $ml ml'),
              if (t.sleepAvgMinutes case final min?)
                _row(
                  '睡眠',
                  '1日平均 ${GrowthRecord.formatDuration(Duration(minutes: min))}',
                ),
              if ((t.firstWeightG, t.lastWeightG) case (
                final first?,
                final last?,
              ))
                _row('体重', _weightChange(first, last)),
              if (t.mealCount > 0) _row('食事', '合計 ${t.mealCount}回'),
              const SizedBox(height: 4),
              Text(
                '平均は記録した日の平均です',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  static String _kg(int g) => (g / 1000).toStringAsFixed(2);

  static String _weightChange(int first, int last) {
    if (first == last) return '${_kg(last)} kg';
    final diff = last - first;
    final sign = diff > 0 ? '+' : '−';
    return '${_kg(first)} → ${_kg(last)} kg（$sign${_kg(diff.abs())} kg）';
  }

  Widget _row(String label, String value) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(width: 88, child: Text(label)),
        Expanded(child: Text(value)),
      ],
    ),
  );
}
