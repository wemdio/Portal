/** @jest-environment node */

/**
 * Coverage for the Jinja2 variable allowlist enforced when users save
 * prompt overrides via /api/tools/li-outreach-v2/settings (PUT).
 *
 * Two things matter for callers:
 *   - the upstream defaults shipped in v2DefaultPrompts.ts must pass without
 *     manual intervention — anyone who clicks «Сбросить к дефолту» and saves
 *     should not get a validation error
 *   - dropping a required {{ var }} produces a clear ru error string listing
 *     every offender by prompt + variable name
 */

import {
  V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT,
  V2_DEFAULT_PROMPT_QUALIFY_LEAD,
  V2_DEFAULT_PROMPT_SEARCH_KEYWORDS,
} from '@/lib/liOutreach/v2DefaultPrompts';
import {
  REQUIRED_VARS_BY_PROMPT,
  buildMissingVarsMessage,
  extractPromptVars,
  findMissingVars,
  validatePromptOverrides,
} from '@/lib/liOutreach/promptVarValidation';

describe('extractPromptVars', () => {
  it('captures top-level identifiers from {{ ... }}', () => {
    const vars = extractPromptVars('hello {{ self_name }} on {{ today }}');
    expect([...vars].sort()).toEqual(['self_name', 'today']);
  });

  it('captures only the root identifier of dotted / piped expressions', () => {
    // foo.bar / foo|trim still root at `foo` — that's the name the user can
    // grep for in their textarea.
    const vars = extractPromptVars('{{ profile.name }} / {{ today|date }} / {{ x() }}');
    expect([...vars].sort()).toEqual(['profile', 'today', 'x']);
  });

  it('ignores {% ... %} blocks — those are control flow, not substitution', () => {
    const vars = extractPromptVars(`
      {% if exclude_keywords %}
      {% for kw in exclude_keywords %}
      - {{ kw }}
      {% endfor %}
      {% endif %}
    `);
    // Only `{{ kw }}` is a substitution; `exclude_keywords` appears only in
    // {% if %}/{% for %} and is intentionally excluded.
    expect([...vars]).toEqual(['kw']);
  });

  it('handles flexible whitespace inside braces', () => {
    const vars = extractPromptVars('{{self_name}} {{    today   }}');
    expect([...vars].sort()).toEqual(['self_name', 'today']);
  });
});

describe('REQUIRED_VARS_BY_PROMPT vs shipped defaults', () => {
  // The whole point of the allowlist is that the defaults satisfy it — if
  // they didn't, the «Сбросить к дефолту» button would put users into a
  // permanently un-saveable state.
  it.each([
    ['follow_up_agent', V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT],
    ['qualify_lead',    V2_DEFAULT_PROMPT_QUALIFY_LEAD],
    ['search_keywords', V2_DEFAULT_PROMPT_SEARCH_KEYWORDS],
  ] as const)('default %s contains every required var', (key, template) => {
    expect(findMissingVars(key, template)).toEqual([]);
  });
});

describe('findMissingVars', () => {
  it('returns missing vars in the order they were declared as required', () => {
    // Order is part of the contract — the UI error string lists them in the
    // same order as declared, so users can match against the allowlist.
    // self_name / today both appear multiple times in the default, so use
    // replaceAll instead of replace to wipe every occurrence.
    const broken = V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT
      .replaceAll('{{ self_name }}', 'я')
      .replaceAll('{{ today }}', 'сегодня');
    expect(findMissingVars('follow_up_agent', broken)).toEqual(['self_name', 'today']);
  });

  it('returns an empty array when every required var is present', () => {
    expect(findMissingVars('qualify_lead', V2_DEFAULT_PROMPT_QUALIFY_LEAD)).toEqual([]);
  });

  it('finds a single missing var', () => {
    const broken = V2_DEFAULT_PROMPT_QUALIFY_LEAD.replace('{{ profile_text }}', '— профиль —');
    expect(findMissingVars('qualify_lead', broken)).toEqual(['profile_text']);
  });
});

describe('validatePromptOverrides', () => {
  it('skips empty strings — those mean "fall back to upstream default"', () => {
    expect(
      validatePromptOverrides({
        prompt_follow_up_agent: '',
        prompt_qualify_lead: '   ',
        prompt_search_keywords: '\n\t',
      }),
    ).toEqual([]);
  });

  it('ignores non-string fields (other settings on the same payload)', () => {
    // PUT route forwards the whole settings body — non-string slots (limits,
    // booleans) must not throw the validator.
    expect(
      validatePromptOverrides({
        prompt_follow_up_agent: undefined,
        prompt_qualify_lead: 42 as unknown as string,
        prompt_search_keywords: null as unknown as string,
      }),
    ).toEqual([]);
  });

  it('returns one entry per broken prompt, with only the missing vars', () => {
    const broken = V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT.replaceAll('{{ self_name }}', '');
    const checks = validatePromptOverrides({
      prompt_follow_up_agent: broken,
      prompt_qualify_lead: V2_DEFAULT_PROMPT_QUALIFY_LEAD,
      prompt_search_keywords: V2_DEFAULT_PROMPT_SEARCH_KEYWORDS,
    });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({ promptKey: 'follow_up_agent', missing: ['self_name'] });
  });

  it('reports multiple offenders in deterministic order', () => {
    const checks = validatePromptOverrides({
      prompt_follow_up_agent: V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT.replaceAll('{{ today }}', ''),
      prompt_qualify_lead: V2_DEFAULT_PROMPT_QUALIFY_LEAD.replaceAll('{{ profile_text }}', ''),
      prompt_search_keywords: V2_DEFAULT_PROMPT_SEARCH_KEYWORDS,
    });
    expect(checks.map((c) => c.promptKey)).toEqual(['follow_up_agent', 'qualify_lead']);
  });
});

describe('buildMissingVarsMessage', () => {
  it('returns "" when nothing is missing', () => {
    expect(buildMissingVarsMessage([])).toBe('');
    expect(buildMissingVarsMessage([{ promptKey: 'qualify_lead', missing: [] }])).toBe('');
  });

  it('lists one offender with its missing vars in {{ ... }} notation', () => {
    expect(
      buildMissingVarsMessage([{ promptKey: 'follow_up_agent', missing: ['self_name', 'today'] }]),
    ).toBe(
      'В промпте «Follow-up agent (диалог)» не хватает переменных: {{ self_name }}, {{ today }}. Добавьте их в текст промпта и попробуйте снова.',
    );
  });

  it('chains multiple offenders into a single human sentence', () => {
    const msg = buildMissingVarsMessage([
      { promptKey: 'follow_up_agent', missing: ['self_name'] },
      { promptKey: 'qualify_lead', missing: ['profile_text'] },
    ]);
    expect(msg).toBe(
      'В промпте «Follow-up agent (диалог)» не хватает переменных: {{ self_name }}. ' +
      'В промпте «Qualify lead (квалификация)» не хватает: {{ profile_text }}. ' +
      'Добавьте их в текст промпта и попробуйте снова.',
    );
  });
});

describe('integration sanity', () => {
  it('end-to-end: broken save produces a ready-to-show ru message', () => {
    const checks = validatePromptOverrides({
      prompt_follow_up_agent: V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT.replaceAll('{{ self_name }}', ''),
    });
    const message = buildMissingVarsMessage(checks);
    expect(message).toContain('{{ self_name }}');
    expect(message).toContain('«Follow-up agent (диалог)»');
    expect(message).toContain('попробуйте снова');
  });

  // Closes the «Сбросить → Сохранить» round-trip: defaults must pass even
  // when no other prompts are saved (other fields undefined).
  it('end-to-end: defaults save cleanly without other prompts set', () => {
    const checks = validatePromptOverrides({
      prompt_follow_up_agent: V2_DEFAULT_PROMPT_FOLLOW_UP_AGENT,
    });
    expect(buildMissingVarsMessage(checks)).toBe('');
  });

  // Sanity: REQUIRED_VARS_BY_PROMPT only references prompts the worker knows.
  it('every required-vars key corresponds to a real prompt slot', () => {
    expect(Object.keys(REQUIRED_VARS_BY_PROMPT).sort()).toEqual(
      ['follow_up_agent', 'qualify_lead', 'search_keywords'].sort(),
    );
  });
});
