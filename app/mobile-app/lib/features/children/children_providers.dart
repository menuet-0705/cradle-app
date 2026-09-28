import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/providers.dart';
import 'child.dart';

class ChildrenRepository {
  ChildrenRepository(this._dio);

  final Dio _dio;
  static final _date = DateFormat('yyyy-MM-dd');

  Future<List<Child>> list() async {
    final res = await _dio.get<List<dynamic>>('/children');
    return res.data!
        .map((e) => Child.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<Child> create({
    required String name,
    required DateTime birthDate,
    Sex? sex,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/children',
      data: _body(name, birthDate, sex),
    );
    return Child.fromJson(res.data!);
  }

  Future<Child> update(
    String id, {
    required String name,
    required DateTime birthDate,
    Sex? sex,
  }) async {
    final res = await _dio.patch<Map<String, dynamic>>(
      '/children/$id',
      data: _body(name, birthDate, sex),
    );
    return Child.fromJson(res.data!);
  }

  Map<String, dynamic> _body(String name, DateTime birthDate, Sex? sex) => {
    'name': name,
    'birthDate': _date.format(birthDate),
    'sex': sex?.name.toUpperCase(),
  };
}

final childrenRepositoryProvider = Provider<ChildrenRepository>(
  (ref) => ChildrenRepository(ref.watch(dioProvider)),
);

final childrenProvider = FutureProvider<List<Child>>((ref) async {
  if (!ref.watch(isLoggedInProvider)) return const [];
  return ref.watch(childrenRepositoryProvider).list();
});

/// 選択中のこどもの ID（未選択なら先頭のこどもを使う）
class SelectedChildId extends Notifier<String?> {
  @override
  String? build() {
    ref.watch(isLoggedInProvider);
    return null;
  }

  void select(String id) => state = id;
}

final selectedChildIdProvider = NotifierProvider<SelectedChildId, String?>(
  SelectedChildId.new,
);

final selectedChildProvider = Provider<AsyncValue<Child?>>((ref) {
  final selectedId = ref.watch(selectedChildIdProvider);
  return ref.watch(childrenProvider).whenData((children) {
    if (children.isEmpty) return null;
    return children.firstWhere(
      (c) => c.id == selectedId,
      orElse: () => children.first,
    );
  });
});
