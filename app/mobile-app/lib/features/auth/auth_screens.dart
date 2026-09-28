import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api_client.dart';
import '../families/pending_invite.dart';
import 'auth_repository.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) => const _AuthForm(isSignup: false);
}

class SignupScreen extends StatelessWidget {
  const SignupScreen({super.key});

  @override
  Widget build(BuildContext context) => const _AuthForm(isSignup: true);
}

class _AuthForm extends ConsumerStatefulWidget {
  const _AuthForm({required this.isSignup});

  final bool isSignup;

  @override
  ConsumerState<_AuthForm> createState() => _AuthFormState();
}

class _AuthFormState extends ConsumerState<_AuthForm> {
  final _formKey = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    final repo = ref.read(authRepositoryProvider);
    try {
      if (widget.isSignup) {
        await repo.signup(
          email: _email.text.trim(),
          password: _password.text,
          name: _name.text.trim(),
        );
      } else {
        await repo.login(email: _email.text.trim(), password: _password.text);
      }
      // 画面遷移はルーターのリダイレクトに任せる
    } catch (e) {
      if (mounted) setState(() => _error = errorMessage(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isSignup = widget.isSignup;
    return Scaffold(
      appBar: AppBar(title: Text(isSignup ? '新規登録' : 'ログイン')),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      Icons.child_care,
                      size: 64,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'すくすく記録',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    const SizedBox(height: 32),
                    // 招待リンクから来た場合（ログイン後に招待の確認画面へ進む）
                    if (ref.watch(pendingInviteCodeProvider) != null) ...[
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(12),
                          child: Text(
                            '家族への招待が届いています。招待メールを受け取ったメールアドレスで'
                            '${isSignup ? '登録' : 'ログイン'}すると、参加の確認画面に進みます。',
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                    ],
                    if (isSignup) ...[
                      TextFormField(
                        controller: _name,
                        decoration: const InputDecoration(labelText: 'お名前'),
                        textInputAction: TextInputAction.next,
                        maxLength: 50,
                        validator: (v) =>
                            (v ?? '').trim().isEmpty ? '入力してください' : null,
                      ),
                      const SizedBox(height: 8),
                    ],
                    TextFormField(
                      controller: _email,
                      decoration: const InputDecoration(labelText: 'メールアドレス'),
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      textInputAction: TextInputAction.next,
                      validator: (v) =>
                          RegExp(r'^\S+@\S+\.\S+$').hasMatch((v ?? '').trim())
                          ? null
                          : 'メールアドレスを入力してください',
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _password,
                      decoration: InputDecoration(
                        labelText: 'パスワード',
                        helperText: isSignup ? '8文字以上' : null,
                      ),
                      obscureText: true,
                      autofillHints: [
                        isSignup
                            ? AutofillHints.newPassword
                            : AutofillHints.password,
                      ],
                      onFieldSubmitted: (_) => _submit(),
                      validator: (v) {
                        final len = (v ?? '').length;
                        if (len == 0) return '入力してください';
                        if (isSignup && len < 8) return '8文字以上にしてください';
                        if (len > 128) return '128文字以内にしてください';
                        return null;
                      },
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      Text(
                        _error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ],
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox.square(
                              dimension: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(isSignup ? '登録する' : 'ログイン'),
                    ),
                    const SizedBox(height: 8),
                    TextButton(
                      onPressed: _submitting
                          ? null
                          : () => context.go(isSignup ? '/login' : '/signup'),
                      child: Text(isSignup ? 'アカウントをお持ちの方はこちら' : 'はじめての方は新規登録'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
