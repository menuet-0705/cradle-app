import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'child.dart';
import 'children_providers.dart';

/// こどもの登録（[child] が null）・編集
class ChildFormScreen extends ConsumerStatefulWidget {
  const ChildFormScreen({super.key, this.child});

  final Child? child;

  @override
  ConsumerState<ChildFormScreen> createState() => _ChildFormScreenState();
}

class _ChildFormScreenState extends ConsumerState<ChildFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.child?.name);
  late DateTime? _birthDate = widget.child?.birthDate;
  late Sex? _sex = widget.child?.sex;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _pickBirthDate() async {
    final now = DateTime.now();
    final tenYearsAgo = DateTime(now.year - 10);
    final current = _birthDate;
    final picked = await showDatePicker(
      context: context,
      initialDate: current ?? now,
      firstDate: current != null && current.isBefore(tenYearsAgo)
          ? current
          : tenYearsAgo,
      lastDate: now,
    );
    if (picked != null) setState(() => _birthDate = picked);
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final repo = ref.read(childrenRepositoryProvider);
    try {
      final existing = widget.child;
      final saved = existing == null
          ? await repo.create(
              name: _name.text.trim(),
              birthDate: _birthDate!,
              sex: _sex,
            )
          : await repo.update(
              existing.id,
              name: _name.text.trim(),
              birthDate: _birthDate!,
              sex: _sex,
            );
      ref.read(selectedChildIdProvider.notifier).select(saved.id);
      ref.invalidate(childrenProvider);
      if (mounted) context.pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(errorMessage(e))));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.child == null ? 'こどもを登録' : 'こどもの情報を編集'),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            TextFormField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'お名前'),
              maxLength: 50,
              validator: (v) => (v ?? '').trim().isEmpty ? '入力してください' : null,
            ),
            const SizedBox(height: 8),
            FormField<DateTime>(
              initialValue: _birthDate,
              validator: (_) => _birthDate == null ? '選択してください' : null,
              builder: (field) => InkWell(
                onTap: () async {
                  await _pickBirthDate();
                  field.didChange(_birthDate);
                },
                child: InputDecorator(
                  decoration: InputDecoration(
                    labelText: '生年月日',
                    errorText: field.errorText,
                    suffixIcon: const Icon(Icons.calendar_today),
                  ),
                  child: Text(
                    _birthDate == null
                        ? '選択してください'
                        : DateFormat.yMMMd('ja').format(_birthDate!),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 24),
            Text('性別（任意）', style: Theme.of(context).textTheme.labelLarge),
            const SizedBox(height: 8),
            SegmentedButton<Sex?>(
              segments: const [
                ButtonSegment(value: Sex.male, label: Text('男の子')),
                ButtonSegment(value: Sex.female, label: Text('女の子')),
                ButtonSegment(value: null, label: Text('未設定')),
              ],
              selected: {_sex},
              onSelectionChanged: (s) => setState(() => _sex = s.first),
            ),
            const SizedBox(height: 32),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: const Text('保存する'),
            ),
          ],
        ),
      ),
    );
  }
}
