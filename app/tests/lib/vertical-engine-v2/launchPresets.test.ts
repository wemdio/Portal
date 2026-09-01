/** @jest-environment node */

import { resolveVeLaunchPresetMailboxTags } from '@/lib/verticalEngineV2/launchPresets';

const tags = [
  { id: 'tag-exact', name: 'VBI' },
  { id: 'tag-shared', name: 'Все клиенты' },
  { id: 'tag-a', name: 'Пул A' },
  { id: 'tag-b', name: 'Пул B' },
];

function mapping(tagId: string, email: string, resourceType = 'account') {
  return {
    id: `${tagId}:${email}`,
    tag_id: tagId,
    resource_id: email,
    resource_type: resourceType,
  };
}

describe('resolveVeLaunchPresetMailboxTags', () => {
  it('prefers exact whole-pool tags and normalizes duplicate mailbox addresses', () => {
    const result = resolveVeLaunchPresetMailboxTags({
      emailAccountIds: [' Sender-A@Example.test ', 'sender-b@example.test', 'SENDER-A@example.test'],
      tags,
      mappings: [
        mapping('tag-exact', 'sender-a@example.test'),
        mapping('tag-exact', 'SENDER-B@EXAMPLE.TEST'),
        mapping('tag-shared', 'sender-a@example.test'),
        mapping('tag-shared', 'sender-b@example.test'),
        mapping('tag-shared', 'unrelated@example.test'),
      ],
    });

    expect(result).toEqual({
      mailbox_count: 2,
      mailbox_tags: [{ id: 'tag-exact', name: 'VBI' }],
      mailbox_tag_resolution: 'exact',
    });
  });

  it('returns all deterministic shared tags when no exact tag exists', () => {
    const result = resolveVeLaunchPresetMailboxTags({
      emailAccountIds: ['a@example.test', 'b@example.test'],
      tags: [
        { id: 'tag-z', name: 'Общий Z' },
        { id: 'tag-a', name: 'Общий A' },
      ],
      mappings: [
        mapping('tag-z', 'a@example.test'),
        mapping('tag-z', 'b@example.test'),
        mapping('tag-z', 'extra-z@example.test'),
        mapping('tag-a', 'a@example.test'),
        mapping('tag-a', 'b@example.test'),
        mapping('tag-a', 'extra-a@example.test'),
      ],
    });

    expect(result).toEqual({
      mailbox_count: 2,
      mailbox_tags: [
        { id: 'tag-a', name: 'Общий A' },
        { id: 'tag-z', name: 'Общий Z' },
      ],
      mailbox_tag_resolution: 'shared',
    });
  });

  it('does not invent one tag when mailbox tags only partially overlap', () => {
    const result = resolveVeLaunchPresetMailboxTags({
      emailAccountIds: ['a@example.test', 'b@example.test'],
      tags,
      mappings: [
        mapping('tag-a', 'a@example.test'),
        mapping('tag-b', 'b@example.test'),
        mapping('tag-exact', 'a@example.test', 'campaign'),
      ],
    });

    expect(result).toEqual({
      mailbox_count: 2,
      mailbox_tags: [],
      mailbox_tag_resolution: 'mixed',
    });
  });

  it('distinguishes no tag data from an unavailable workspace lookup', () => {
    expect(
      resolveVeLaunchPresetMailboxTags({
        emailAccountIds: ['a@example.test'],
        tags,
        mappings: [],
      }),
    ).toEqual({ mailbox_count: 1, mailbox_tags: [], mailbox_tag_resolution: 'none' });

    expect(
      resolveVeLaunchPresetMailboxTags({
        emailAccountIds: ['a@example.test'],
        tags: [],
        mappings: [],
        available: false,
      }),
    ).toEqual({ mailbox_count: 1, mailbox_tags: [], mailbox_tag_resolution: 'unavailable' });
  });

  it('keeps an empty preset explicit without treating unrelated mappings as mixed', () => {
    expect(
      resolveVeLaunchPresetMailboxTags({
        emailAccountIds: [],
        tags,
        mappings: [mapping('tag-a', 'a@example.test')],
      }),
    ).toEqual({ mailbox_count: 0, mailbox_tags: [], mailbox_tag_resolution: 'none' });
  });
});
