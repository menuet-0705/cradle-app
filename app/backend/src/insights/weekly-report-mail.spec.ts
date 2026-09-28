import { buildWeeklyReportMail } from './weekly-report-mail.js';

describe('buildWeeklyReportMail', () => {
  it('does not put user input in the subject and escapes HTML', () => {
    const mail = buildWeeklyReportMail({
      to: 'mama@example.com',
      childName: '<b>たろう</b>\r\nBcc: x@example.com',
      appUrl: 'https://cradle.example.com',
    });
    expect(mail.subject).toBe('今週のふりかえりレポートができました');
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('&lt;b&gt;たろう&lt;/b&gt;');
    expect(mail.text).not.toMatch(/\r|\nBcc/);
    expect(mail.text).toContain('https://cradle.example.com/');
  });
});
