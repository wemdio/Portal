/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('SBIS exact OKVED offline planner wiring', () => {
  it('pins the real reference, snapshot identity, replay, and pre-publish validation', () => {
    const script = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/plan-sbis-exact-okved.ts'),
      'utf8',
    );

    expect(script).toContain('OKVED2_TREE');
    expect(script).toContain('EXPECTED_CANDIDATE_DIGEST');
    expect(script).toContain('source_analysis_sha256');
    expect(script).toContain('candidate_key_sha256');
    expect(script).toContain('repeatedEligible');
    expect(script).toContain('processSbisExactPlanFiles');
    expect(script.indexOf('processSbisExactPlanFiles')).toBeLessThan(
      script.indexOf('await rename(stage, args.out)'),
    );
  });
});
