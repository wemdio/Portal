import { extractImageLinks, mapInstantlyEmailToThreadMessage } from '@/lib/clientCampaignReplies/mapEmail';

describe('client reply image links', () => {
  it('keeps a linked screenshot even when the plain-text body takes priority', () => {
    const body = {
      text: 'См. скриншот 1.',
      html: '<p>См. скриншот 1.</p><img src="https://cdn.example.test/clip.png">' +
        '<a class="attachment-link" href="https://files.example.test/attachments/image.png?x=1&amp;y=2">image.png</a>',
    };
    const message = mapInstantlyEmailToThreadMessage({ id: 'm-1', ue_type: 2, body });

    expect(message.body_text).toBe('См. скриншот 1.');
    expect(message.image_links).toEqual([{
      url: 'https://files.example.test/attachments/image.png?x=1&y=2',
      name: 'image.png',
    }]);
  });

  it('does not expose scripts, insecure URLs, decorative images or duplicate links', () => {
    expect(extractImageLinks({ html: `
      <a href="javascript:alert(1)">image.png</a>
      <a href="http://files.example.test/image.png">image.png</a>
      <a href="https://user:pass@files.example.test/image.png">image.png</a>
      <a href="https://files.example.test/document.pdf">document.pdf</a>
      <img src="https://cdn.example.test/tracker.png">
      <a href="https://files.example.test/real.webp">real.webp</a>
      <a href="https://files.example.test/real.webp">again</a>
    ` })).toEqual([{ url: 'https://files.example.test/real.webp', name: 'real.webp' }]);
  });

  it('handles missing HTML without an attachment', () => {
    expect(extractImageLinks({ text: 'plain text' })).toEqual([]);
    expect(extractImageLinks(undefined)).toEqual([]);
  });
});
