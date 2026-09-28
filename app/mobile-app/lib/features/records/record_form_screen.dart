import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'growth_record.dart';
import 'records_providers.dart';

/// 記録の入力。種類ごとに必要な項目だけを出す
class RecordFormScreen extends ConsumerStatefulWidget {
  const RecordFormScreen({
    super.key,
    required this.childId,
    required this.type,
    required this.initialDay,
  });

  final String childId;
  final RecordType type;
  final DateTime initialDay;

  @override
  ConsumerState<RecordFormScreen> createState() => _RecordFormScreenState();
}

class _RecordFormScreenState extends ConsumerState<RecordFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _weightKg = TextEditingController();
  final _note = TextEditingController();
  MealAmount? _mealAmount;
  MealReaction? _mealReaction;
  late DateTime _startedAt;
  late DateTime _endedAt;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    // 今日なら現在時刻、過去の日なら「その日の現在と同じ時刻」を初期値にする
    final now = DateTime.now();
    final d = widget.initialDay;
    _startedAt = DateTime(d.year, d.month, d.day, now.hour, now.minute);
    _endedAt = _startedAt;
    if (widget.type == RecordType.sleep) {
      _startedAt = _startedAt.subtract(const Duration(hours: 1));
    }
  }

  @override
  void dispose() {
    _amount.dispose();
    _weightKg.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<DateTime?> _pickDateTime(DateTime initial) async {
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2000),
      lastDate: DateTime.now(),
    );
    if (date == null || !mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(initial),
    );
    if (time == null) return null;
    return DateTime(date.year, date.month, date.day, time.hour, time.minute);
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    final type = widget.type;
    if (type == RecordType.sleep && !_endedAt.isAfter(_startedAt)) {
      _showError('終了時刻は開始時刻より後にしてください');
      return;
    }
    final latest = type == RecordType.sleep ? _endedAt : _startedAt;
    if (latest.isAfter(DateTime.now())) {
      _showError('未来の時刻は記録できません');
      return;
    }
    setState(() => _saving = true);
    try {
      await ref
          .read(recordsRepositoryProvider)
          .create(
            widget.childId,
            NewRecord(
              type: type,
              startedAt: _startedAt,
              endedAt: type == RecordType.sleep ? _endedAt : null,
              amountMl: type == RecordType.milk
                  ? int.parse(_amount.text)
                  : null,
              weightG: type == RecordType.weight
                  ? (double.parse(_weightKg.text) * 1000).round()
                  : null,
              note: _note.text.trim(),
              mealAmount: type == RecordType.meal ? _mealAmount : null,
              mealReaction: type == RecordType.meal ? _mealReaction : null,
            ),
          );
      invalidateRecords(ref);
      if (mounted) context.pop();
    } catch (e) {
      _showError(errorMessage(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final type = widget.type;
    final isSleep = type == RecordType.sleep;
    return Scaffold(
      appBar: AppBar(title: Text('${type.label}を記録')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            _DateTimeField(
              label: isSleep ? '寝た時刻' : '日時',
              value: _startedAt,
              onTap: () async {
                final v = await _pickDateTime(_startedAt);
                if (v != null) setState(() => _startedAt = v);
              },
            ),
            if (isSleep) ...[
              const SizedBox(height: 16),
              _DateTimeField(
                label: '起きた時刻',
                value: _endedAt,
                onTap: () async {
                  final v = await _pickDateTime(_endedAt);
                  if (v != null) setState(() => _endedAt = v);
                },
              ),
            ],
            const SizedBox(height: 16),
            if (type == RecordType.milk)
              TextFormField(
                controller: _amount,
                decoration: const InputDecoration(
                  labelText: '量',
                  suffixText: 'ml',
                ),
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                validator: (v) {
                  final n = int.tryParse(v ?? '');
                  if (n == null || n < 1 || n > 500) {
                    return '1〜500 の数値を入力してください';
                  }
                  return null;
                },
              ),
            if (type == RecordType.weight)
              TextFormField(
                controller: _weightKg,
                decoration: const InputDecoration(
                  labelText: '体重',
                  suffixText: 'kg',
                  hintText: '例: 5.25',
                ),
                keyboardType: const TextInputType.numberWithOptions(
                  decimal: true,
                ),
                inputFormatters: [
                  FilteringTextInputFormatter.allow(RegExp(r'^\d*\.?\d{0,3}')),
                ],
                validator: (v) {
                  final n = double.tryParse(v ?? '');
                  if (n == null || n < 0.3 || n > 50) {
                    return '0.3〜50 の数値を入力してください';
                  }
                  return null;
                },
              ),
            TextFormField(
              controller: _note,
              decoration: InputDecoration(
                labelText: type == RecordType.meal ? '食べたもの' : 'メモ（任意）',
                hintText: type == RecordType.meal ? '例: おかゆ、にんじん' : null,
              ),
              maxLength: 500,
              maxLines: type == RecordType.meal ? 3 : 1,
              validator: (v) =>
                  type == RecordType.meal && (v ?? '').trim().isEmpty
                  ? '入力してください'
                  : null,
            ),
            if (type == RecordType.meal) ...[
              // 好みの推定（食事の提案）に使う。どちらも任意で、選び直すと解除できる
              _OptionalChoice<MealAmount>(
                label: '食べた量（任意）',
                values: MealAmount.values,
                labelOf: (v) => v.label,
                selected: _mealAmount,
                onChanged: (v) => setState(() => _mealAmount = v),
              ),
              const SizedBox(height: 16),
              _OptionalChoice<MealReaction>(
                label: '反応（任意）',
                values: MealReaction.values,
                labelOf: (v) => v.label,
                selected: _mealReaction,
                onChanged: (v) => setState(() => _mealReaction = v),
              ),
            ],
            const SizedBox(height: 24),
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

class _OptionalChoice<T> extends StatelessWidget {
  const _OptionalChoice({
    required this.label,
    required this.values,
    required this.labelOf,
    required this.selected,
    required this.onChanged,
  });

  final String label;
  final List<T> values;
  final String Function(T) labelOf;
  final T? selected;
  final ValueChanged<T?> onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            for (final v in values)
              ChoiceChip(
                label: Text(labelOf(v)),
                selected: selected == v,
                onSelected: (on) => onChanged(on ? v : null),
              ),
          ],
        ),
      ],
    );
  }
}

class _DateTimeField extends StatelessWidget {
  const _DateTimeField({
    required this.label,
    required this.value,
    required this.onTap,
  });

  final String label;
  final DateTime value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: InputDecorator(
        decoration: InputDecoration(
          labelText: label,
          suffixIcon: const Icon(Icons.schedule),
        ),
        child: Text(DateFormat('M月d日(E) HH:mm', 'ja').format(value)),
      ),
    );
  }
}
