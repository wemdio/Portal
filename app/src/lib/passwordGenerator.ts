const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SPECIALS = '!@#$%^&*-_+=';
const ALL = LOWER + UPPER + DIGITS + SPECIALS;

function pickOne(pool: string): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return pool[buf[0] % pool.length];
}

function shuffle(chars: string[]): string[] {
  for (let i = chars.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars;
}

export function generateStrongPassword(length = 14): string {
  if (length < 8) throw new Error('Password length must be at least 8');
  if (length > 72) throw new Error('Password length must be at most 72 (bcrypt cap)');

  const required = [pickOne(LOWER), pickOne(UPPER), pickOne(DIGITS), pickOne(SPECIALS)];
  const rest = Array.from({ length: length - required.length }, () => pickOne(ALL));
  return shuffle([...required, ...rest]).join('');
}
