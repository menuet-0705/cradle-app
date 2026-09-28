import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'insights.dart';
import 'insights_providers.dart';
import 'insights_tab.dart';

class WeeklyReportScreen extends ConsumerWidget {
  const WeeklyReportScreen({
    super.key,
    required this.childId,
    required this.reportId,
  });

  final String childId;
  final String reportId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final report = ref.watch(
      weeklyReportProvider((childId: childId, reportId: reportId)),
    );
    return Scaffold(
      appBar: AppBar(title: const Text('週のふりかえり')),
      body: report.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(errorMessage(e))),
        // 作成中・失敗したレポート（通知から直接開いた場合など）は本文がない
        data: (r) => switch (r.summary.status) {
          ReportStatus.ready => _ReportBody(report: r),
          ReportStatus.pending => const Center(
            child: Text('レポートを作成中です。しばらくしてから開いてください'),
          ),
          ReportStatus.failed => const Center(child: Text('このレポートは作成できませんでした')),
        },
      ),
    );
  }
}

class _ReportBody extends StatelessWidget {
  const _ReportBody({required this.report});

  final WeeklyReport report;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final fmt = DateFormat('M月d日(E)', 'ja');
    final s = report.summary;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '${fmt.format(s.periodStart)}〜${fmt.format(s.periodEnd)}',
          style: theme.textTheme.bodySmall,
        ),
        const SizedBox(height: 4),
        Text(s.headline ?? '', style: theme.textTheme.headlineSmall),
        if (report.consultDoctor) ...[
          const SizedBox(height: 16),
          Card(
            color: theme.colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    Icons.local_hospital_outlined,
                    color: theme.colorScheme.onErrorContainer,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      'かかりつけ医や保健師への相談をおすすめします。\n${report.consultReason}',
                      style: TextStyle(
                        color: theme.colorScheme.onErrorContainer,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
        _Section('よかった点', Icons.thumb_up_alt_outlined, report.goodPoints),
        _Section('気になる点', Icons.info_outline, report.concerns),
        _Section('傾向', Icons.trending_up, report.trends),
        _Section('来週のヒント', Icons.lightbulb_outline, report.nextWeekTips),
        const SizedBox(height: 24),
        Text(
          aiDisclaimer,
          style: theme.textTheme.bodySmall?.copyWith(color: theme.hintColor),
        ),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.title, this.icon, this.items);

  final String title;
  final IconData icon;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 20),
              const SizedBox(width: 8),
              Text(title, style: Theme.of(context).textTheme.titleMedium),
            ],
          ),
          const SizedBox(height: 8),
          for (final item in items)
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Text('・$item'),
            ),
        ],
      ),
    );
  }
}
