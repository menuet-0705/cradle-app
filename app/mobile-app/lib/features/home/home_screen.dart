import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../ai/ai_tab.dart';
import '../auth/auth_repository.dart';
import '../charts/charts_tab.dart';
import '../children/child.dart';
import '../children/children_providers.dart';
import '../records/growth_record.dart';
import '../records/records_providers.dart';
import '../records/records_tab.dart';

/// ホームのタブ。URL のクエリ（?tab=）の値として使う
enum HomeTab {
  records('記録', Icons.list_alt_outlined),
  charts('グラフ', Icons.show_chart),
  ai('AIによる分析', Icons.auto_awesome_outlined);

  const HomeTab(this.label, this.icon);

  final String label;
  final IconData icon;

  /// 不明な値・未指定は「記録」
  static HomeTab fromQuery(String? value) =>
      values.firstWhere((t) => t.name == value, orElse: () => records);

  String get location => this == records ? '/' : '/?tab=$name';
}

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key, this.tab = HomeTab.records});

  final HomeTab tab;

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  late final AppLifecycleListener _lifecycle;
  DateTime? _hiddenAt;

  @override
  void initState() {
    super.initState();
    // しばらく離れていた・日付が変わったときだけ、他の家族の記録や日付の変化を反映する
    // （コントロールセンター表示などの短い中断では再取得しない）
    _lifecycle = AppLifecycleListener(
      onHide: () => _hiddenAt = DateTime.now(),
      onShow: () {
        final hiddenAt = _hiddenAt;
        _hiddenAt = null;
        if (hiddenAt == null) return;
        final now = DateTime.now();
        if (now.difference(hiddenAt) > const Duration(minutes: 5) ||
            !DateUtils.isSameDay(now, hiddenAt)) {
          invalidateRecords(ref);
        }
      },
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  // 画面遷移とデータの破棄はログイン状態の変化で自動的に行われる
  Future<void> _logout() => ref.read(authRepositoryProvider).logout();

  Future<void> _addRecord(Child child) async {
    final type = await showModalBottomSheet<RecordType>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final t in RecordType.values)
              ListTile(
                leading: Icon(t.icon),
                title: Text(t.label),
                onTap: () => Navigator.pop(context, t),
              ),
          ],
        ),
      ),
    );
    if (type == null || !mounted) return;
    final day = ref.read(selectedDayProvider) ?? today();
    context.push(
      '/records/new',
      extra: (childId: child.id, type: type, day: day),
    );
  }

  @override
  Widget build(BuildContext context) {
    final children = ref.watch(childrenProvider);
    final selected = ref.watch(selectedChildProvider);
    final child = selected.value;

    return Scaffold(
      appBar: AppBar(
        title: child == null
            ? const Text('すくすく記録')
            : _ChildSwitcher(
                current: child,
                children: children.value ?? const [],
              ),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) => switch (v) {
              'edit' => context.push('/children/edit', extra: child),
              'add' => context.push('/children/new'),
              'family' => context.push('/family'),
              'invite' => context.push('/invite'),
              'logout' => _logout(),
              _ => null,
            },
            itemBuilder: (_) => [
              if (child != null)
                const PopupMenuItem(value: 'edit', child: Text('こどもの情報を編集')),
              const PopupMenuItem(value: 'add', child: Text('こどもを追加')),
              const PopupMenuDivider(),
              const PopupMenuItem(value: 'family', child: Text('家族・招待')),
              const PopupMenuItem(value: 'invite', child: Text('招待コードを入力')),
              const PopupMenuDivider(),
              const PopupMenuItem(value: 'logout', child: Text('ログアウト')),
            ],
          ),
        ],
      ),
      body: selected.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(errorMessage(e)),
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: () => ref.invalidate(childrenProvider),
                child: const Text('再読み込み'),
              ),
            ],
          ),
        ),
        data: (child) => child == null
            ? _NoChildren(onAdd: () => context.push('/children/new'))
            // 表示中のタブだけを作り、グラフ・AI の分析は開いたときに取得する
            : switch (widget.tab) {
                HomeTab.records => RecordsTab(childId: child.id),
                HomeTab.charts => ChartsTab(childId: child.id),
                // こどもを切り替えたら生成中の表示・エラーを持ち越さない
                HomeTab.ai => AiTab(key: ValueKey(child.id), childId: child.id),
              },
      ),
      floatingActionButton: child == null || widget.tab != HomeTab.records
          ? null
          : FloatingActionButton(
              tooltip: '記録を追加',
              onPressed: () => _addRecord(child),
              child: const Icon(Icons.add),
            ),
      bottomNavigationBar: child == null
          ? null
          : NavigationBar(
              selectedIndex: widget.tab.index,
              // タブの切り替えはブラウザの履歴に積まない（「戻る」で前の画面に戻れるように）
              onDestinationSelected: (i) => Router.neglect(
                context,
                () => context.go(HomeTab.values[i].location),
              ),
              // 並びは HomeTab の宣言順（selectedIndex と HomeTab.values[i] の対応をずらさない）
              destinations: [
                for (final t in HomeTab.values)
                  NavigationDestination(icon: Icon(t.icon), label: t.label),
              ],
            ),
    );
  }
}

/// AppBar のタイトル。タップでこどもを切り替える
class _ChildSwitcher extends ConsumerWidget {
  const _ChildSwitcher({required this.current, required this.children});

  final Child current;
  final List<Child> children;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final title = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(current.name),
        Text(
          current.ageLabel(DateTime.now()),
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
    if (children.length < 2) return title;
    return PopupMenuButton<String>(
      tooltip: 'こどもを切り替える',
      onSelected: (id) => ref.read(selectedChildIdProvider.notifier).select(id),
      itemBuilder: (_) => [
        for (final c in children)
          CheckedPopupMenuItem(
            value: c.id,
            checked: c.id == current.id,
            child: Text(c.name),
          ),
      ],
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [title, const Icon(Icons.arrow_drop_down)],
      ),
    );
  }
}

class _NoChildren extends StatelessWidget {
  const _NoChildren({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.child_friendly_outlined, size: 64),
            const SizedBox(height: 16),
            const Text('まずはこどもを登録しましょう', textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton.icon(
              onPressed: onAdd,
              icon: const Icon(Icons.add),
              label: const Text('こどもを登録'),
            ),
          ],
        ),
      ),
    );
  }
}
