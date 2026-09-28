import { buildInviteMail } from './invite-mail.js';

const base = {
  to: 'papa@example.com',
  inviterName: 'ママ',
  familyName: 'ママの家族',
  code: 'K7QM4XP2HN',
  appUrl: 'https://cradle.example.com',
  expiresAt: new Date('2026-10-01T03:00:00Z'),
};

describe('buildInviteMail', () => {
  it('includes the link, formatted code and expiry', () => {
    const mail = buildInviteMail(base);
    expect(mail.to).toBe('papa@example.com');
    expect(mail.subject).toBe('「すくすく記録」の家族への招待が届きました');
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain('https://cradle.example.com/invite#K7QM4XP2HN');
      expect(body).toContain('K7QM-4XP2-HN');
      expect(body).toContain('2026年10月1日 12:00');
    }
  });

  it('escapes HTML and strips control characters from user-supplied names', () => {
    const mail = buildInviteMail({
      ...base,
      inviterName: '<img src=x onerror=alert(1)>\r\nBcc: evil@example.com',
      familyName: '"><script>x</script>',
    });
    expect(mail.subject).not.toContain('evil');
    expect(mail.text).not.toMatch(/Bcc: evil@example.com\n/);
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('removes bidi and zero-width characters from names', () => {
    const mail = buildInviteMail({
      ...base,
      inviterName: 'マ\u200bマ\u202Eevil\u2066',
    });
    expect(mail.text).toContain('マ マ evilさんから');
    expect(mail.text).not.toMatch(/[\u200b\u202e\u2066]/);
  });
});
