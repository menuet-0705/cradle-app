enum FamilyRole {
  owner('管理者'),
  member('メンバー');

  const FamilyRole(this.label);
  final String label;

  static FamilyRole fromApi(String v) => v == 'OWNER' ? owner : member;
}

class FamilyMember {
  const FamilyMember({
    required this.userId,
    required this.name,
    required this.role,
  });

  factory FamilyMember.fromJson(Map<String, dynamic> json) => FamilyMember(
    userId: json['userId'] as String,
    name: json['name'] as String,
    role: FamilyRole.fromApi(json['role'] as String),
  );

  final String userId;
  final String name;
  final FamilyRole role;
}

class Family {
  const Family({
    required this.id,
    required this.name,
    required this.myRole,
    required this.members,
    this.aiEnabled = false,
  });

  factory Family.fromJson(Map<String, dynamic> json) => Family(
    id: json['id'] as String,
    name: json['name'] as String,
    myRole: FamilyRole.fromApi(json['myRole'] as String),
    aiEnabled: json['aiEnabled'] as bool? ?? false,
    members: (json['members'] as List<dynamic>)
        .map((m) => FamilyMember.fromJson(m as Map<String, dynamic>))
        .toList(),
  );

  final String id;
  final String name;
  final FamilyRole myRole;
  final List<FamilyMember> members;

  /// AI 機能（食事の提案・週次レポート）に管理者が同意済みか
  final bool aiEnabled;

  bool get isOwner => myRole == FamilyRole.owner;
}

class PendingInvite {
  const PendingInvite({
    required this.id,
    required this.email,
    required this.expiresAt,
    this.invitedByName,
  });

  factory PendingInvite.fromJson(Map<String, dynamic> json) => PendingInvite(
    id: json['id'] as String,
    email: json['email'] as String,
    expiresAt: DateTime.parse(json['expiresAt'] as String).toLocal(),
    invitedByName:
        (json['createdBy'] as Map<String, dynamic>?)?['name'] as String?,
  );

  final String id;
  final String email;
  final DateTime expiresAt;
  final String? invitedByName;
}

class InvitePreview {
  const InvitePreview({
    required this.familyName,
    required this.expiresAt,
    this.inviterName,
  });

  factory InvitePreview.fromJson(Map<String, dynamic> json) => InvitePreview(
    familyName: json['familyName'] as String,
    inviterName: json['inviterName'] as String?,
    expiresAt: DateTime.parse(json['expiresAt'] as String).toLocal(),
  );

  final String familyName;
  final String? inviterName;
  final DateTime expiresAt;
}
