import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../insights/ai_consent.dart';
import 'family.dart';

class FamiliesRepository {
  FamiliesRepository(this._dio);

  final Dio _dio;

  Future<List<Family>> list() async {
    final res = await _dio.get<List<dynamic>>('/families');
    return res.data!
        .map((e) => Family.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<List<PendingInvite>> invites(String familyId) async {
    final res = await _dio.get<List<dynamic>>('/families/$familyId/invites');
    return res.data!
        .map((e) => PendingInvite.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> invite(String familyId, String email) =>
      _dio.post<void>('/families/$familyId/invites', data: {'email': email});

  Future<void> revokeInvite(String familyId, String inviteId) =>
      _dio.delete<void>('/families/$familyId/invites/$inviteId');

  /// AI 機能への同意・取り消し（管理者のみ）
  Future<void> setAiConsent(String familyId, {required bool enabled}) => enabled
      ? _dio.post<void>(
          '/families/$familyId/ai-consent',
          data: {'version': aiConsentVersion},
        )
      : _dio.delete<void>('/families/$familyId/ai-consent');

  /// 自分なら退出、他人なら削除（管理者のみ）
  Future<void> removeMember(String familyId, String userId) =>
      _dio.delete<void>('/families/$familyId/members/$userId');

  // コードは URL ではなく本文で送る（アクセスログに残さない）
  Future<InvitePreview> preview(String code) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/invites/preview',
      data: {'code': code},
    );
    return InvitePreview.fromJson(res.data!);
  }

  /// 参加した家族の ID を返す
  Future<String> accept(String code) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '/invites/accept',
      data: {'code': code},
    );
    return res.data!['familyId'] as String;
  }
}

final familiesRepositoryProvider = Provider<FamiliesRepository>(
  (ref) => FamiliesRepository(ref.watch(dioProvider)),
);

final familiesProvider = FutureProvider<List<Family>>((ref) async {
  if (!ref.watch(isLoggedInProvider)) return const [];
  return ref.watch(familiesRepositoryProvider).list();
});

final familyInvitesProvider = FutureProvider.autoDispose
    .family<List<PendingInvite>, String>(
      (ref, familyId) =>
          ref.watch(familiesRepositoryProvider).invites(familyId),
    );

/// ログイン中のユーザー ID（メンバー一覧で「あなた」を示すため）
final myUserIdProvider = FutureProvider<String?>((ref) async {
  if (!ref.watch(isLoggedInProvider)) return null;
  final res = await ref.watch(dioProvider).get<Map<String, dynamic>>('/me');
  return res.data!['id'] as String;
});
