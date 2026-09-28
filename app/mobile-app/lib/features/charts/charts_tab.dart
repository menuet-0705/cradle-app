import 'dart:math';

import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../records/records_providers.dart';

class ChartsTab extends ConsumerWidget {
  const ChartsTab({super.key, required this.childId});

  final String childId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return RefreshIndicator(
      onRefresh: () => Future.wait([
        ref.refresh(weightSeriesProvider(childId).future),
        ref.refresh(milkDailyProvider(childId).future),
      ]),
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _Section(
            title: '体重の推移',
            child: ref
                .watch(weightSeriesProvider(childId))
                .when(
                  loading: _loading,
                  error: (e, _) => Text(errorMessage(e)),
                  data: (points) => points.isEmpty
                      ? const _Empty('体重を記録するとグラフが表示されます')
                      : _WeightChart(points: points),
                ),
          ),
          const SizedBox(height: 24),
          _Section(
            title: 'ミルクの量（直近$milkChartDays日）',
            child: ref
                .watch(milkDailyProvider(childId))
                .when(
                  loading: _loading,
                  error: (e, _) => Text(errorMessage(e)),
                  data: (days) => days.isEmpty
                      ? const _Empty('ミルクを記録するとグラフが表示されます')
                      : _MilkChart(days: days),
                ),
          ),
        ],
      ),
    );
  }

  static Widget _loading() => const SizedBox(
    height: 200,
    child: Center(child: CircularProgressIndicator()),
  );
}

class _WeightChart extends StatelessWidget {
  const _WeightChart({required this.points});

  final List<WeightPoint> points;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    final origin = points.first.date;
    // X 軸は最初の記録からの経過日数
    double x(DateTime d) => d.difference(origin).inHours / 24;
    final spots = [for (final p in points) FlSpot(x(p.date), p.weightG / 1000)];
    final fmt = DateFormat('M/d');
    final maxX = spots.last.x == 0 ? 1.0 : spots.last.x;

    return SizedBox(
      height: 220,
      child: LineChart(
        LineChartData(
          minX: 0,
          maxX: maxX,
          lineBarsData: [
            LineChartBarData(
              spots: spots,
              color: color,
              barWidth: 3,
              dotData: const FlDotData(show: true),
            ),
          ],
          gridData: const FlGridData(drawVerticalLine: false),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 44,
                getTitlesWidget: (v, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(
                    '${v.toStringAsFixed(1)}kg',
                    style: const TextStyle(fontSize: 10),
                  ),
                ),
              ),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                reservedSize: 28,
                // 日付ラベルが重ならないよう最大 5 本程度にする
                interval: max(1, (maxX / 5).ceilToDouble()),
                getTitlesWidget: (v, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(
                    fmt.format(origin.add(Duration(hours: (v * 24).round()))),
                    style: const TextStyle(fontSize: 10),
                  ),
                ),
              ),
            ),
          ),
          lineTouchData: LineTouchData(
            touchTooltipData: LineTouchTooltipData(
              getTooltipItems: (spots) => [
                for (final s in spots)
                  LineTooltipItem(
                    '${s.y.toStringAsFixed(2)} kg',
                    const TextStyle(color: Colors.white),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MilkChart extends StatelessWidget {
  const _MilkChart({required this.days});

  final List<MilkDaily> days;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.primary;
    // 記録がない日も 0 として並べる
    final today = DateUtils.dateOnly(DateTime.now());
    final byDate = {for (final d in days) d.date: d};
    final range = [
      for (var i = milkChartDays - 1; i >= 0; i--)
        DateTime(today.year, today.month, today.day - i),
    ];
    final fmt = DateFormat('d');

    return SizedBox(
      height: 220,
      child: BarChart(
        BarChartData(
          barGroups: [
            for (var i = 0; i < range.length; i++)
              BarChartGroupData(
                x: i,
                barRods: [
                  BarChartRodData(
                    toY: (byDate[range[i]]?.totalMl ?? 0).toDouble(),
                    color: color,
                    width: 12,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ],
              ),
          ],
          gridData: const FlGridData(drawVerticalLine: false),
          borderData: FlBorderData(show: false),
          titlesData: FlTitlesData(
            topTitles: const AxisTitles(),
            rightTitles: const AxisTitles(),
            leftTitles: const AxisTitles(
              sideTitles: SideTitles(showTitles: true, reservedSize: 40),
            ),
            bottomTitles: AxisTitles(
              sideTitles: SideTitles(
                showTitles: true,
                getTitlesWidget: (v, meta) => SideTitleWidget(
                  meta: meta,
                  child: Text(
                    fmt.format(range[v.toInt()]),
                    style: const TextStyle(fontSize: 10),
                  ),
                ),
              ),
            ),
          ),
          barTouchData: BarTouchData(
            touchTooltipData: BarTouchTooltipData(
              getTooltipItem: (group, _, rod, _) {
                final d = byDate[range[group.x]];
                return BarTooltipItem(
                  '${rod.toY.toInt()} ml（${d?.count ?? 0}回）',
                  const TextStyle(color: Colors.white),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 16),
        child,
      ],
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 120,
    child: Center(child: Text(text, textAlign: TextAlign.center)),
  );
}
