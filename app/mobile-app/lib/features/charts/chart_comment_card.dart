import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../ai/ai_models.dart';
import '../ai/ai_providers.dart';

/// 家族の誰かが作成中のとき、できあがりを確かめに行く間隔と回数（約 90 秒で打ち切る）
const _pollInterval = Duration(seconds: 3);
const _maxPolls = 30;

/// グラフの下の AI のコメント。
/// 開いたとき、サーバーが「作るべき」（今日の記録があり、今日のコメントがまだない）と返したら自動で作る
class ChartCommentCard extends ConsumerStatefulWidget {
  const ChartCommentCard({
    super.key,
    required this.childId,
    required this.chart,
  });

  final String childId;
  final ChartKind chart;

  @override
  ConsumerState<ChartCommentCard> createState() => _ChartCommentCardState();
}

class _ChartCommentCardState extends ConsumerState<ChartCommentCard> {
  bool _generating = false;
  String? _error;
  // 自動で作るのは、この画面を開いている間に 1 回だけ（失敗・上限で繰り返し送らない。
  // 失敗の後はサーバーが 5 分待たせるので、開き直したときに作り直す）
  bool _autoRequested = false;
  Timer? _poll;
  int _polls = 0;

  ({String childId, ChartKind chart}) get _key =>
      (childId: widget.childId, chart: widget.chart);

  @override
  void initState() {
    super.initState();
    ChartComment? previousComment;
    ref.listenManual(chartCommentProvider(_key), (_, next) {
      final state = next.value;
      if (state == null) return;
      // 新しいコメントが届いたら、前の失敗の表示は消す
      if (state.comment?.createdAt != previousComment?.createdAt &&
          _error != null) {
        setState(() => _error = null);
      }
      previousComment = state.comment;
      if (state.needsUpdate && !_autoRequested && !_generating) {
        _autoRequested = true;
        _generate();
      }
      _poll?.cancel();
      if (state.generating && _polls < _maxPolls) {
        _poll = Timer(_pollInterval, () {
          _polls++;
          if (mounted) ref.invalidate(chartCommentProvider(_key));
        });
      }
    }, fireImmediately: true);
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _generate() async {
    setState(() {
      _generating = true;
      _error = null;
    });
    try {
      await ref
          .read(aiRepositoryProvider)
          .createChartComment(widget.childId, widget.chart);
    } catch (e) {
      if (mounted) setState(() => _error = _errorMessage(e));
    } finally {
      if (mounted) {
        setState(() => _generating = false);
        ref.invalidate(chartCommentProvider(_key));
      }
    }
  }

  static String _errorMessage(Object e) {
    if (e is DioException &&
        e.response?.statusCode == 429 &&
        (e.response?.data as Map?)?['code'] == 'DAILY_LIMIT') {
      return '今日のコメントの更新回数を使い切りました。また明日お試しください';
    }
    return aiErrorMessage(e);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final state = ref.watch(chartCommentProvider(_key));
    final comment = state.value?.comment;
    final working = _generating || (state.value?.generating ?? false);

    return Card(
      margin: EdgeInsets.zero,
      elevation: 0,
      color: scheme.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(20),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 16,
                  backgroundColor: scheme.primary,
                  child: Icon(
                    Icons.auto_awesome,
                    size: 18,
                    color: scheme.onPrimary,
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'AI のコメント',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
                if (comment != null)
                  Text(
                    DateFormat('M/d HH:mm').format(comment.createdAt),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            ...state.when(
              loading: () => const [
                Center(
                  child: Padding(
                    padding: EdgeInsets.all(8),
                    child: CircularProgressIndicator(),
                  ),
                ),
              ],
              error: (e, _) => [Text(errorMessage(e))],
              data: (s) => [
                if (working) ...[
                  Row(
                    children: [
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'AI がコメントを考えています…',
                          style: theme.textTheme.bodySmall,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                ],
                if (s.limitReached || s.retryLater) ...[
                  Text(
                    s.limitReached
                        ? '今日はコメントを作れませんでした。明日また表示されます'
                        : 'コメントを作れませんでした。少し時間をおいて開き直してください',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                if (comment != null)
                  // 作っている間は、前のコメントを薄く出しておく
                  Opacity(
                    opacity: working ? 0.5 : 1,
                    child: _CommentBody(comment),
                  )
                else if (!working && !s.limitReached && !s.retryLater)
                  Text(
                    s.enabled
                        ? '今日の${widget.chart.label}を記録すると、AI のコメントが表示されます'
                        : 'AI 機能は現在利用できません',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
              ],
            ),
            // 失敗の直後・上限のときはサーバーの状態に応じた案内を出すので、同じ内容を重ねて出さない
            if (_error case final error?
                when !(state.value?.retryLater ?? false) &&
                    !(state.value?.limitReached ?? false)) ...[
              const SizedBox(height: 8),
              Text(error, style: TextStyle(color: scheme.error)),
            ],
            const SizedBox(height: 12),
            Text(
              'AI による参考情報です。体調の心配は医師・保健師に相談してください。',
              style: theme.textTheme.bodySmall?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// まとめ（太字）・ポイント（チェック付きの行）・アドバイス（色付きの囲み）
class _CommentBody extends StatelessWidget {
  const _CommentBody(this.comment);

  final ChartComment comment;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final body = theme.textTheme.bodyMedium?.copyWith(height: 1.6);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          comment.headline,
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.bold,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 10),
        for (final (i, point) in comment.points.indexed) ...[
          if (i > 0) const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 3),
                child: Icon(
                  Icons.check_circle_outline,
                  size: 16,
                  color: scheme.primary,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(child: Text(point, style: body)),
            ],
          ),
        ],
        const SizedBox(height: 12),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: scheme.tertiaryContainer,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.lightbulb_outline,
                size: 18,
                color: scheme.onTertiaryContainer,
                semanticLabel: 'アドバイス',
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  comment.advice,
                  style: body?.copyWith(color: scheme.onTertiaryContainer),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
