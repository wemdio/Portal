import { mailboxSendingView } from '@/lib/byoMailbox/sendingStatusView';

describe('mailboxSendingView', () => {
  it('читает статус отправки из служебных полей строки API', () => {
    expect(
      mailboxSendingView({
        instantly_status: 'registered',
        instantly_error: null,
      }),
    ).toEqual({ sendingStatus: 'registered', sendingError: null });
  });

  it('не падает на строке без служебных полей', () => {
    expect(mailboxSendingView({ email: 'a@b.com' })).toEqual({
      sendingStatus: null,
      sendingError: null,
    });
  });
});
