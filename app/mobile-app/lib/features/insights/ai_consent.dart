import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../families/families_providers.dart';
import '../families/family.dart';

/// 同意の版。下の説明文（送るデータ・送り先）を変えたらサーバーと一緒に上げる
const aiConsentVersion = 1;

/// 同意の前に見せる説明
const aiConsentDescription = '''
「ふりかえり」の食事の提案と週次レポートは、AI（Anthropic 社の Claude）が作ります。
そのために、次の情報を Anthropic 社（米国）のサーバーに送ります。

・こどもの月齢・性別
・アレルギー・避けたい食材
・ミルク・睡眠・体重・食事の記録

食事のメモは入力した内容のまま送ります（名前などを書かないようご注意ください）。
こどもの名前の欄や、家族の名前・メールアドレスは送りません。
同意は家族の管理者が行い、家族全員の記録に適用されます。家族の画面からいつでも取り消せます（取り消すと、以後は送りません）。''';

/// 同意していない家族に出すカード。管理者なら同意できる
class AiConsentCard extends ConsumerStatefulWidget {
  const AiConsentCard({super.key, required this.family});

  final Family family;

  @override
  ConsumerState<AiConsentCard> createState() => _AiConsentCardState();
}

class _AiConsentCardState extends ConsumerState<AiConsentCard> {
  bool _saving = false;
  String? _error;

  Future<void> _consent() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('AI 機能を使いますか？'),
        content: const SingleChildScrollView(child: Text(aiConsentDescription)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('やめる'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('同意して使う'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ref
          .read(familiesRepositoryProvider)
          .setAiConsent(widget.family.id, enabled: true);
      ref.invalidate(familiesProvider);
    } catch (e) {
      if (mounted) setState(() => _error = errorMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isOwner = widget.family.isOwner;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.auto_awesome, color: theme.colorScheme.primary),
                const SizedBox(width: 8),
                Text('AI でふりかえる', style: theme.textTheme.titleMedium),
              ],
            ),
            const SizedBox(height: 8),
            const Text('記録をもとに、AI が次の食事を提案したり、毎週金曜に 1 週間のふりかえりレポートを作ったりします。'),
            const SizedBox(height: 12),
            if (isOwner)
              FilledButton(
                onPressed: _saving ? null : _consent,
                child: const Text('説明を読んで使いはじめる'),
              )
            else
              Text(
                'この機能は、家族の管理者が同意すると使えるようになります。',
                style: theme.textTheme.bodySmall,
              ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ],
          ],
        ),
      ),
    );
  }
}
