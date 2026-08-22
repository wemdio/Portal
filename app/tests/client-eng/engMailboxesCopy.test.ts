import { readFileSync } from 'fs';
import path from 'path';

const page = readFileSync(
  path.join(__dirname, '../../src/app/client/eng/mailboxes/page.tsx'),
  'utf8',
);

describe('ENG mailbox connect copy', () => {
  it('не называет отправляющего провайдера', () => {
    expect(page).not.toMatch(/instantly/i);
  });
});
