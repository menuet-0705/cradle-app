import {
  formatInviteCode,
  generateInviteCode,
  hashInviteCode,
  normalizeInviteCode,
} from './invite-code.js';

describe('invite code', () => {
  it('generates unambiguous 10-character codes', () => {
    const codes = new Set(Array.from({ length: 500 }, generateInviteCode));
    expect(codes.size).toBe(500);
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
  });

  it('normalizes user input and rejects invalid codes', () => {
    expect(normalizeInviteCode(' k7qm-4xp2-hn ')).toBe('K7QM4XP2HN');
    expect(normalizeInviteCode('K7QM 4XP2 HN')).toBe('K7QM4XP2HN');
    expect(normalizeInviteCode('K7QM4XP2H')).toBeNull(); // 短い
    expect(normalizeInviteCode('K7QM4XP2H0')).toBeNull(); // 0 は使わない
    expect(normalizeInviteCode("K7QM4XP2H'")).toBeNull();
  });

  it('formats for display and hashes deterministically', () => {
    expect(formatInviteCode('K7QM4XP2HN')).toBe('K7QM-4XP2-HN');
    expect(hashInviteCode('K7QM4XP2HN')).toBe(hashInviteCode('K7QM4XP2HN'));
    expect(hashInviteCode('K7QM4XP2HN')).not.toContain('K7QM');
  });
});
