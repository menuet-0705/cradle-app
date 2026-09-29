import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api_client.dart';
import 'growth_record.dart';
import 'records_providers.dart';

/// 記録の入力（新規・修正）。種類ごとに必要な項目だけを出す
class RecordFormScreen extends ConsumerStatefulWidget {
  const RecordFormScreen({
    super.key,
    required this.childId,
    required this.type,
    required this.initialDay,
  }) : record = null;

  /// 登録済みの記録の修正。入力欄は記録の値で埋める
  RecordFormScreen.edit({
    super.key,
    required this.childId,
    required GrowthRecord this.record,
  }) : type = record.type,
       initialDay = DateUtils.dateOnly(record.startedAt);

  final String childId;
  final RecordType type;
  final DateTime initialDay;

  /// 修正する記録（新規なら null）
  final GrowthRecord? record;

  @override
  ConsumerState<RecordFormScreen> createState() => _RecordFormScreenState();
}

class _RecordFormScreenState extends ConsumerState<RecordFormScreen> {
  final _formKey = GlobalKey<FormState>();
  final _amount = TextEditingController();
  final _weightKg = TextEditingController();
  final _note = TextEditingController();
  late DateTime _startedAt;
  late DateTime _endedAt;
  bool _saving = false;
  late MealSlot _mealSlot;
  bool _slotChosen = false;
  // 体重・食事: 選んでいる日の記録済みの内容を入力欄に反映する購読と、利用者が入力欄を触ったか
  ProviderSubscription<AsyncValue<List<GrowthRecord>>>? _dayRecord;
  bool _edited = false;

  bool get _isEdit => widget.record != null;

  @override
  void initState() {
    super.initState();
    if (widget.record case final r?) {
      _startedAt = r.startedAt;
      _endedAt = r.endedAt ?? r.startedAt;
      _amount.text = r.amountMl?.toString() ?? '';
      _weightKg.text = r.weightG == null ? '' : (r.weightG! / 1000).toString();
      _mealSlot = r.mealSlot ?? MealSlot.at(r.startedAt);
      // 区分は記録のものを保つ（時刻を変えても追従させない）
      _slotChosen = true;
      _note.text = r.note ?? '';
      return;
    }
    // 今日なら現在時刻、過去の日なら「その日の現在と同じ時刻」を初期値にする
    final now = DateTime.now();
    final d = widget.initialDay;
    _startedAt = DateTime(d.year, d.month, d.day, now.hour, now.minute);
    _endedAt = _startedAt;
    if (widget.type == RecordType.sleep) {
      _startedAt = _startedAt.subtract(const Duration(hours: 1));
    }
    _mealSlot = MealSlot.at(_startedAt);
    if (widget.type.oncePerDay) _followDayRecord();
  }

  /// 体重は 1 日 1 件、食事は区分ごとに 1 件。選んでいる日（・区分）が記録済みなら内容を入れ、
  /// なければ空にする（保存すると上書き）。日付・区分を変えたら呼び直す。利用者が入力した内容は消さない
  void _followDayRecord() {
    _dayRecord?.close();
    // 読み込みが終わるまで、前の日の値を新しい日の値として保存させない
    if (!_edited) {
      _weightKg.clear();
      _note.clear();
    }
    _dayRecord = ref.listenManual(_dayRecords(_startedAt), (_, next) {
      if (!next.hasValue || _edited) return;
      final existing = _existingOf(next.value);
      if (widget.type == RecordType.weight) {
        _weightKg.text = existing == null
            ? ''
            : (existing.weightG! / 1000).toString();
      }
      _note.text = existing?.note ?? '';
    }, fireImmediately: true);
  }

  FutureProvider<List<GrowthRecord>> _dayRecords(DateTime at) =>
      dayRecordsProvider((
        childId: widget.childId,
        day: DateUtils.dateOnly(at),
      ));

  /// 選んでいる日（食事は区分も）にある、同じ種類の別の記録。
  /// 新規では保存すると上書きされる記録（一覧は新しい順なので、サーバーが上書きする 1 件と同じ）、
  /// 修正では重複になるため保存できない原因の記録
  GrowthRecord? _existingOf(List<GrowthRecord>? records) => records
      ?.where(
        (r) =>
            r.id != widget.record?.id &&
            r.type == widget.type &&
            (r.type != RecordType.meal || r.mealSlot == _mealSlot),
      )
      .firstOrNull;

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
      final input = NewRecord(
        type: type,
        startedAt: _startedAt,
        endedAt: type == RecordType.sleep ? _endedAt : null,
        amountMl: type == RecordType.milk ? int.parse(_amount.text) : null,
        weightG: type == RecordType.weight
            ? (double.parse(_weightKg.text) * 1000).round()
            : null,
        mealSlot: type == RecordType.meal ? _mealSlot : null,
        note: _note.text.trim(),
      );
      final repo = ref.read(recordsRepositoryProvider);
      if (widget.record case final r?) {
        await repo.update(r.id, input);
      } else {
        await repo.create(widget.childId, input);
      }
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
    // 選んでいる日（食事は区分も）に別の記録があれば、新規は上書き、修正は重複で保存できない
    final dayRecords = type.oncePerDay
        ? ref.watch(_dayRecords(_startedAt))
        : null;
    final hasOther = _existingOf(dayRecords?.value) != null;
    final overwrites = hasOther && !_isEdit;
    // 修正で日付・区分を変えたときだけ重複を確かめる（サーバーと同じ。以前からの重複も値は直せる）
    final original = widget.record;
    final moved =
        original != null &&
        (!DateUtils.isSameDay(_startedAt, original.startedAt) ||
            (type == RecordType.meal && _mealSlot != original.mealSlot));
    final duplicate = hasOther && moved;
    // 移動先の日の記録を読み込み中は、重複か分からないので保存させない
    // （取得に失敗したときは保存を許し、サーバーの 409 で止める）
    final checking = moved && type.oncePerDay && dayRecords!.isLoading;
    final target = type == RecordType.meal ? _mealSlot.label : type.label;
    final errorColor = Theme.of(context).colorScheme.error;
    final title = _isEdit ? '修正' : (overwrites ? '更新' : '記録');
    return Scaffold(
      appBar: AppBar(title: Text('${type.label}を$title')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            if (overwrites)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Row(
                  children: [
                    const Icon(Icons.info_outline),
                    const SizedBox(width: 8),
                    Expanded(child: Text('この日の$targetは記録済みです。保存すると上書きされます')),
                  ],
                ),
              ),
            if (duplicate)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Row(
                  children: [
                    Icon(Icons.error_outline, color: errorColor),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'この日の$targetはすでに記録されています。日付を変えるか、そちらの記録を修正してください',
                        style: TextStyle(color: errorColor),
                      ),
                    ),
                  ],
                ),
              ),
            _DateTimeField(
              label: isSleep ? '寝た時刻' : '日時',
              value: _startedAt,
              onTap: () async {
                final v = await _pickDateTime(_startedAt);
                if (v == null) return;
                final dayChanged = !DateUtils.isSameDay(v, _startedAt);
                // 食事は、区分を手で選ぶまでは時刻に合わせて区分も変える
                final slot = type == RecordType.meal && !_slotChosen
                    ? MealSlot.at(v)
                    : _mealSlot;
                final slotChanged = slot != _mealSlot;
                setState(() {
                  _startedAt = v;
                  _mealSlot = slot;
                });
                // 修正では、他の記録の内容で入力欄を埋め直さない
                if (type.oncePerDay &&
                    !_isEdit &&
                    (dayChanged || slotChanged)) {
                  _followDayRecord();
                }
              },
            ),
            if (type == RecordType.meal) ...[
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final slot in MealSlot.values)
                    ChoiceChip(
                      label: Text(slot.label),
                      selected: slot == _mealSlot,
                      onSelected: (_) {
                        _slotChosen = true;
                        if (slot == _mealSlot) return;
                        setState(() => _mealSlot = slot);
                        if (!_isEdit) _followDayRecord();
                      },
                    ),
                ],
              ),
            ],
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
                onChanged: (_) => _edited = true,
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
              // 記録済みの内容の反映（_followDayRecord）で、入力した内容を消さないため
              onChanged: (_) => _edited = true,
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
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _saving || duplicate || checking ? null : _save,
              child: Text(overwrites ? '更新する' : '保存する'),
            ),
          ],
        ),
      ),
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
