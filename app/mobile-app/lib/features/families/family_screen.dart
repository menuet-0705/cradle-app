import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import '../children/children_providers.dart';
import 'families_providers.dart';
import 'family.dart';

/// 家族のメンバーと招待の管理
class FamilyScreen extends ConsumerWidget {
  const FamilyScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final families = ref.watch(familiesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('家族')),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(familiesProvider.future),
        child: families.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => ListView(
            children: [
              const SizedBox(height: 120),
              Text(errorMessage(e), textAlign: TextAlign.center),
            ],
          ),
          data: (list) => ListView(
            padding: const EdgeInsets.only(bottom: 32),
            children: [for (final f in list) _FamilySection(family: f)],
          ),
        ),
      ),
    );
  }
}

class _FamilySection extends ConsumerWidget {
  const _FamilySection({required this.family});

  final Family family;

  Future<void> _invite(BuildContext context, WidgetRef ref) async {
    final email = await showDialog<String>(
      context: context,
      builder: (_) => const _InviteDialog(),
    );
    if (email == null || !context.mounted) return;
    try {
      await ref.read(familiesRepositoryProvider).invite(family.id, email);
      ref.invalidate(familyInvitesProvider(family.id));
      if (context.mounted) _snack(context, '$email に招待メールを送信しました');
    } catch (e) {
      if (context.mounted) _snack(context, _inviteError(e));
    }
  }

  Future<void> _revoke(
    BuildContext context,
    WidgetRef ref,
    PendingInvite invite,
  ) async {
    final ok = await _confirm(
      context,
      title: '招待を取り消しますか？',
      body: '${invite.email} に送った招待リンク・コードは使えなくなります。',
      action: '取り消す',
    );
    if (!ok || !context.mounted) return;
    try {
      await ref
          .read(familiesRepositoryProvider)
          .revokeInvite(family.id, invite.id);
      ref.invalidate(familyInvitesProvider(family.id));
    } catch (e) {
      if (context.mounted) _snack(context, errorMessage(e));
    }
  }

  Future<void> _remove(
    BuildContext context,
    WidgetRef ref,
    FamilyMember member, {
    required bool isSelf,
  }) async {
    final ok = await _confirm(
      context,
      title: isSelf ? 'この家族から抜けますか？' : '${member.name}さんを家族から外しますか？',
      body: isSelf
          ? '「${family.name}」のこどもの記録が見られなくなります。もう一度参加するには招待が必要です。'
          : '${member.name}さんは「${family.name}」のこどもの記録が見られなくなります。',
      action: isSelf ? '抜ける' : '外す',
    );
    if (!ok || !context.mounted) return;
    try {
      await ref
          .read(familiesRepositoryProvider)
          .removeMember(family.id, member.userId);
      ref.invalidate(familiesProvider);
      if (isSelf) {
        // 見えるこどもが変わるので、選択も含めて読み直す
        ref.invalidate(childrenProvider);
        ref.invalidate(selectedChildIdProvider);
      }
    } catch (e) {
      if (context.mounted) _snack(context, errorMessage(e));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final myId = ref.watch(myUserIdProvider).value;
    final invites = ref.watch(familyInvitesProvider(family.id));
    final theme = Theme.of(context);
    final fmt = DateFormat('M月d日 HH:mm', 'ja');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 8),
          child: Text(family.name, style: theme.textTheme.titleLarge),
        ),
        _Header('メンバー'),
        for (final m in family.members)
          ListTile(
            leading: CircleAvatar(
              child: Text(m.name.isEmpty ? '?' : m.name.characters.first),
            ),
            title: Text(m.userId == myId ? '${m.name}（あなた）' : m.name),
            subtitle: Text(m.role.label),
            trailing: m.userId == myId
                ? (family.isOwner
                      ? null
                      : TextButton(
                          onPressed: () =>
                              _remove(context, ref, m, isSelf: true),
                          child: const Text('抜ける'),
                        ))
                : (family.isOwner && m.role == FamilyRole.member
                      ? IconButton(
                          tooltip: '家族から外す',
                          icon: const Icon(Icons.person_remove_outlined),
                          onPressed: () =>
                              _remove(context, ref, m, isSelf: false),
                        )
                      : null),
          ),
        _Header('招待中'),
        invites.when(
          loading: () => const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (e, _) => ListTile(title: Text(errorMessage(e))),
          data: (list) => list.isEmpty
              ? const ListTile(dense: true, title: Text('招待中の人はいません'))
              : Column(
                  children: [
                    for (final i in list)
                      ListTile(
                        leading: const Icon(Icons.mail_outline),
                        title: Text(i.email),
                        subtitle: Text('${fmt.format(i.expiresAt)} まで有効'),
                        trailing: IconButton(
                          tooltip: '招待を取り消す',
                          icon: const Icon(Icons.close),
                          onPressed: () => _revoke(context, ref, i),
                        ),
                      ),
                  ],
                ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: FilledButton.icon(
            onPressed: () => _invite(context, ref),
            icon: const Icon(Icons.person_add_alt),
            label: const Text('メールで招待'),
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
    child: Text(
      text,
      style: Theme.of(context).textTheme.labelLarge
          ?.copyWith(color: Theme.of(context).hintColor),
    ),
  );
}

class _InviteDialog extends StatefulWidget {
  const _InviteDialog();

  @override
  State<_InviteDialog> createState() => _InviteDialogState();
}

class _InviteDialogState extends State<_InviteDialog> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  void _submit() {
    if (!_formKey.currentState!.validate()) return;
    Navigator.pop(context, _email.text.trim().toLowerCase());
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('メールで招待'),
      content: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              '招待リンクとコードをメールで送ります。相手はこのメールアドレスでログイン（または新規登録）すると参加できます。',
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _email,
              autofocus: true,
              decoration: const InputDecoration(labelText: 'メールアドレス'),
              keyboardType: TextInputType.emailAddress,
              onFieldSubmitted: (_) => _submit(),
              validator: (v) =>
                  RegExp(r'^\S+@\S+\.\S+$').hasMatch((v ?? '').trim())
                  ? null
                  : 'メールアドレスを入力してください',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('キャンセル'),
        ),
        FilledButton(onPressed: _submit, child: const Text('送信')),
      ],
    );
  }
}

String _inviteError(Object e) {
  if (e is DioException) {
    final data = e.response?.data;
    // サーバーのメッセージ文ではなく code で判定する
    switch (data is Map ? data['code'] : null) {
      case 'ALREADY_MEMBER':
        return 'この人はすでに家族のメンバーです';
      case 'TOO_MANY_PENDING':
        return '招待中の人が多すぎます。不要な招待を取り消してください';
      case 'INVITE_LIMIT':
        return '送れる招待の数の上限に達しました。時間をおいてからお試しください';
      case 'MAIL_UNAVAILABLE':
        return 'メールを送信できませんでした。時間をおいて再度お試しください';
    }
    if (e.response?.statusCode == 503) {
      return 'メールを送信できませんでした。時間をおいて再度お試しください';
    }
  }
  return errorMessage(e);
}

void _snack(BuildContext context, String message) =>
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));

Future<bool> _confirm(
  BuildContext context, {
  required String title,
  required String body,
  required String action,
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    ) ==
    true;
