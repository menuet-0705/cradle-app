import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'growth_record.dart';
import 'record_groups.dart';
import 'records_providers.dart';

/// 日付を移動するスワイプとみなす横方向の速さ（px/秒）。ゆっくりしたドラッグでは移動しない
const _swipeVelocity = 300.0;

/// 選択中の日の記録一覧
class RecordsTab extends ConsumerWidget {
  const RecordsTab({super.key, required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final day = ref.watch(selectedDayProvider) ?? today();
    final records = ref.watch(dayRecordsProvider((childId: childId, day: day)));
    final selectedDay = ref.read(selectedDayProvider.notifier);
    void previousDay() => selectedDay.shift(-1);
    // 今日より先には進めない
    final nextDay = day.isBefore(today()) ? () => selectedDay.shift(1) : null;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          child: Row(
            children: [
              IconButton(
                tooltip: '前の日',
                icon: const Icon(Icons.chevron_left),
                onPressed: previousDay,
              ),
              Expanded(
                child: Text(
                  DateFormat('M月d日(E)', 'ja').format(day),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: '次の日',
                icon: const Icon(Icons.chevron_right),
                onPressed: nextDay,
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          // 右スワイプで前の日、左スワイプで次の日（一覧の縦スクロールとは取り合わない）
          child: GestureDetector(
            // 読み込み中など、一覧が画面を埋めていないときもスワイプを受け付ける
            behavior: HitTestBehavior.opaque,
            onHorizontalDragEnd: (details) {
              final v = details.primaryVelocity ?? 0;
              if (v > _swipeVelocity) previousDay();
              if (v < -_swipeVelocity) nextDay?.call();
            },
            child: RefreshIndicator(
              onRefresh: () => ref.refresh(
                dayRecordsProvider((childId: childId, day: day)).future,
              ),
              child: records.when(
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
                              _RecordTile(record: record),
                              const Divider(height: 1),
                            ],
                          ],
                        ],
                      ),
              ),
            ),
          ),
        ),
      ],
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
  const _RecordTile({required this.record});

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
