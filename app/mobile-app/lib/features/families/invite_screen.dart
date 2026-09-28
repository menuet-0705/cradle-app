import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../auth/auth_repository.dart';
import '../children/children_providers.dart';
import 'families_providers.dart';
import 'family.dart';
import 'pending_invite.dart';

/// 招待コードの入力（Web の招待リンクから来た場合は入力済み）→ 確認 → 参加
class InviteScreen extends ConsumerStatefulWidget {
  const InviteScreen({super.key});

  @override
  ConsumerState<InviteScreen> createState() => _InviteScreenState();
}

class _InviteScreenState extends ConsumerState<InviteScreen> {
  late final _code = TextEditingController(
    text: ref.read(pendingInviteCodeProvider),
  );
  InvitePreview? _preview;
  String? _error;
  // 招待が使えなかった（別のアカウントでログインしている可能性がある）
  bool _invalid = false;
  bool _busy = false;
  // アカウント切り替え中は、ログイン後に戻ってくるためコードを残す
  bool _switchingAccount = false;
  // dispose では ref を使えないので、先に取得しておく
  late final PendingInviteCode _pending;

  @override
  void initState() {
    super.initState();
    _pending = ref.read(pendingInviteCodeProvider.notifier);
    // 招待リンクから来た場合は、開いた時点で内容を確認する
    if (_code.text.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _check());
    }
  }

  @override
  void dispose() {
    // 参加せずに画面を離れたら、以後のログインで招待画面に戻らないようコードを捨てる
    // （dispose 中はプロバイダを変更できないので、フレームの後に行う）
    if (!_switchingAccount) {
      final pending = _pending;
      WidgetsBinding.instance.addPostFrameCallback((_) => pending.clear());
    }
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() task) async {
    setState(() {
      _busy = true;
      _error = null;
      _invalid = false;
    });
    try {
      await task();
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = _message(e);
          _invalid = e is DioException && e.response?.statusCode == 404;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check() => _run(() async {
    final preview = await ref
        .read(familiesRepositoryProvider)
        .preview(_code.text.trim());
    if (mounted) setState(() => _preview = preview);
  });

  Future<void> _join() => _run(() async {
    final familyId = await ref
        .read(familiesRepositoryProvider)
        .accept(_code.text.trim());
    _pending.clear();
    ref.invalidate(familiesProvider);
    ref.invalidate(childrenProvider);
    ref.invalidate(selectedChildIdProvider);
    // 参加した家族のこどもを表示する。読み直しに失敗しても参加自体は済んでいるので続ける
    try {
      final children = await ref.read(childrenProvider.future);
      final joined = children.where((c) => c.familyId == familyId).firstOrNull;
      if (joined != null) {
        ref.read(selectedChildIdProvider.notifier).select(joined.id);
      }
    } catch (_) {}
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('「${_preview?.familyName ?? '家族'}」に参加しました')),
    );
    context.go('/');
  });

  /// 招待を受けたアドレスのアカウントに切り替える（ログイン後にこの画面へ戻る）
  Future<void> _switchAccount() async {
    _switchingAccount = true;
    _pending.set(_code.text.trim());
    await ref.read(authRepositoryProvider).logout();
  }

  String _message(Object e) {
    if (e is DioException && e.response?.statusCode == 404) {
      return 'この招待は使えません。コードの間違い・期限切れ・使用済みのほか、'
          '招待メールを受け取ったアドレスとは別のアカウントでログインしている可能性があります';
    }
    return errorMessage(e);
  }

  @override
  Widget build(BuildContext context) {
    final preview = _preview;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('家族に参加')),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const Text('招待メールに書かれているコードを入力してください。'),
          const SizedBox(height: 16),
          TextField(
            controller: _code,
            enabled: !_busy && preview == null,
            decoration: const InputDecoration(
              labelText: '招待コード',
              hintText: '例: K7QM-4XP2-HN',
            ),
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            onSubmitted: (_) => _check(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            if (_invalid)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: _busy ? null : _switchAccount,
                  child: const Text('別のアカウントでログインする'),
                ),
              ),
          ],
          const SizedBox(height: 24),
          if (preview == null)
            FilledButton(
              onPressed: _busy ? null : _check,
              child: const Text('確認する'),
            )
          else ...[
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(preview.familyName, style: theme.textTheme.titleLarge),
                    const SizedBox(height: 8),
                    if (preview.inviterName != null)
                      Text('${preview.inviterName}さんからの招待です'),
                    Text(
                      '有効期限: ${DateFormat('M月d日 HH:mm', 'ja').format(preview.expiresAt)}',
                      style: theme.textTheme.bodySmall,
                    ),
                    const SizedBox(height: 8),
                    const Text('参加すると、この家族のこどもの記録を一緒に見たり記録したりできます。'),
                    const SizedBox(height: 8),
                    Text(
                      'あなたの家族にまだこどもが登録されていない場合、その家族は削除され、'
                      'この家族にまとまります。',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _busy ? null : _join,
              child: const Text('参加する'),
            ),
            TextButton(
              onPressed: _busy ? null : () => setState(() => _preview = null),
              child: const Text('コードを入力し直す'),
            ),
          ],
        ],
      ),
    );
  }
}
