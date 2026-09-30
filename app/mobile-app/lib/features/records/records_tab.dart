import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'growth_record.dart';
import 'record_groups.dart';
import 'records_providers.dart';

/// さかのぼれる日数（ページ数 - 1）
const _maxPastDays = 3650;

/// 前後の日へのページ送り（矢印ボタン）の動き
const _pageDuration = Duration(milliseconds: 300);

/// 選択中の日の記録一覧。1 日を 1 ページにして、左右にめくって日付を移動する（ViewPager と同じ動き）
class RecordsTab extends ConsumerStatefulWidget {
  const RecordsTab({super.key, required this.childId});

  final String childId;

  @override
  ConsumerState<RecordsTab> createState() => _RecordsTabState();
}

class _RecordsTabState extends ConsumerState<RecordsTab> {
  /// ページ番号の基準の日（ページ番号 = この日から何日前か）
  late DateTime _today;
  late PageController _pages;
  late final AppLifecycleListener _lifecycle;
  Timer? _midnight;

  @override
  void initState() {
    super.initState();
    _today = today();
    _pages = _controller();
    // 日付が変わったら今日のページを作り直す（アプリに戻ったとき・開いたまま 0 時を過ぎたとき）
    _lifecycle = AppLifecycleListener(onShow: _followToday);
    _scheduleMidnight();
  }

  @override
  void dispose() {
    _midnight?.cancel();
    _lifecycle.dispose();
    _pages.dispose();
    super.dispose();
  }

  // ページ番号は選んでいる日から決めるので、保存されたスクロール位置は使わない
  PageController _controller() => PageController(
    initialPage: _pageOf(ref.read(selectedDayProvider) ?? _today),
    keepPage: false,
  );

  void _scheduleMidnight() {
    final now = DateTime.now();
    final next = DateTime(now.year, now.month, now.day + 1);
    _midnight = Timer(next.difference(now) + const Duration(seconds: 1), () {
      _followToday();
      _scheduleMidnight();
    });
  }

  /// 日付が変わっていたら、新しい今日を基準にページを作り直す
  void _followToday() {
    final now = today();
    if (!mounted || now == _today) return;
    final old = _pages;
    setState(() {
      _today = now;
      _pages = _controller();
    });
    // 古い PageView はこのフレームの描画までコントローラを使うので、描画の後で破棄する
    WidgetsBinding.instance.addPostFrameCallback((_) => old.dispose());
  }

  // 夏時間の切り替えで 1 日が 23・25 時間になっても日数がずれないよう、UTC の日付で数える。
  // さかのぼれるのは _maxPastDays まで（それより前の日は最も古いページに寄せる）
  int _pageOf(DateTime day) =>
      DateTime.utc(_today.year, _today.month, _today.day)
          .difference(DateTime.utc(day.year, day.month, day.day))
          .inDays
          .clamp(0, _maxPastDays);

  DateTime _dayOf(int page) =>
      DateTime(_today.year, _today.month, _today.day - page);

  /// 矢印ボタンで動かしている途中の行き先（素早く続けて押したときに、その先へ進めるため）
  int? _animatingTo;

  /// 矢印ボタン: [delta] 日だけページを動かす（+1 で前の日、-1 で次の日）
  Future<void> _step(int base, int delta) async {
    final target = ((_animatingTo ?? base) + delta).clamp(0, _maxPastDays);
    _animatingTo = target;
    await _pages.animateToPage(
      target,
      duration: _pageDuration,
      curve: Curves.easeInOut,
    );
    if (_animatingTo == target) _animatingTo = null;
  }

  /// 月間カレンダーを開く。日付を選んで戻ってきたら、その日のページへ移る
  Future<void> _openCalendar(DateTime day) async {
    final picked = await context.push<DateTime>(
      '/records/calendar',
      extra: (childId: widget.childId, month: DateTime(day.year, day.month)),
    );
    if (picked == null || !mounted) return;
    // ページが変わると onPageChanged で選んでいる日も追従する
    _pages.jumpToPage(_pageOf(picked));
  }

  @override
  Widget build(BuildContext context) {
    // 選んでいる日はページを動かしたときだけ変わる（ページが先に動き、onPageChanged で追従する）
    final day = ref.watch(selectedDayProvider) ?? _today;
    final page = _pageOf(day);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            children: [
              IconButton(
                tooltip: '前の日',
                icon: const Icon(Icons.chevron_left),
                onPressed: page < _maxPastDays ? () => _step(page, 1) : null,
              ),
              Expanded(
                // 日付をタップすると月間カレンダーを開く
                child: Center(
                  child: Tooltip(
                    message: 'カレンダーで見る',
                    child: TextButton.icon(
                      onPressed: () => _openCalendar(day),
                      icon: const Icon(Icons.calendar_month_outlined),
                      label: Text(
                        DateFormat('M月d日(E)', 'ja').format(day),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                  ),
                ),
              ),
              IconButton(
                tooltip: '次の日',
                icon: const Icon(Icons.chevron_right),
                // 今日より先には進めない
                onPressed: page > 0 ? () => _step(page, -1) : null,
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          // reverse: 今日（0 ページ目）が右端。右スワイプで前の日、左スワイプで次の日
          child: PageView.builder(
            key: ValueKey(_today),
            controller: _pages,
            reverse: true,
            itemCount: _maxPastDays + 1,
            onPageChanged: (p) =>
                ref.read(selectedDayProvider.notifier).select(_dayOf(p)),
            itemBuilder: (_, p) =>
                _DayRecords(childId: widget.childId, day: _dayOf(p)),
          ),
        ),
      ],
    );
  }
}

/// 1 日分（1 ページ）の記録一覧。種類ごとにまとめて出す
class _DayRecords extends ConsumerWidget {
  const _DayRecords({required this.childId, required this.day});

  final String childId;
  final DateTime day;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = dayRecordsProvider((childId: childId, day: day));
    return RefreshIndicator(
      onRefresh: () => ref.refresh(provider.future),
      child: ref
          .watch(provider)
          .when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => _Message(errorMessage(e)),
            data: (items) => items.isEmpty
                ? const _Message('この日の記録はまだありません\n右下の＋から追加できます')
                : ListView(
                    padding: const EdgeInsets.only(bottom: 96),
                    children: [
                      for (final group in groupRecords(items)) ...[
                        _GroupHeader(group),
                        for (final record in group.records) ...[
                          _RecordTile(childId: childId, record: record),
                          const Divider(height: 1),
                        ],
                      ],
                    ],
                  ),
          ),
    );
  }
}

/// 種類ごとのグループの見出し（件数・合計）
class _GroupHeader extends StatelessWidget {
  const _GroupHeader(this.group);

  final RecordGroup group;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Text(
        group.header,
        style: theme.textTheme.titleSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _RecordTile extends ConsumerWidget {
  const _RecordTile({required this.childId, required this.record});

  final String childId;
  final GrowthRecord record;

  Future<void> _delete(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('記録を削除しますか？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('削除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(recordsRepositoryProvider).delete(record.id);
      invalidateRecords(ref);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(errorMessage(e))));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final time = DateFormat.Hm();
    final timeLabel = record.endedAt == null
        ? time.format(record.startedAt)
        : '${time.format(record.startedAt)}〜${time.format(record.endedAt!)}';
    final note = record.type == RecordType.meal ? null : record.note;
    return ListTile(
      // タップで修正画面を開く
      onTap: () => context.push(
        '/records/edit',
        extra: (childId: childId, record: record),
      ),
      leading: CircleAvatar(child: Icon(record.type.icon)),
      title: Text('${record.label}  ${record.summary}'),
      subtitle: Text(
        [timeLabel, ?note, ?record.createdByName].join('  ·  '),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: IconButton(
        tooltip: '削除',
        icon: const Icon(Icons.delete_outline),
        onPressed: () => _delete(context, ref),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    // RefreshIndicator を効かせるためスクロール可能にしておく
    return ListView(
      children: [
        const SizedBox(height: 120),
        Text(text, textAlign: TextAlign.center),
      ],
    );
  }
}
