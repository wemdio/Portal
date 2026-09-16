/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { constructorAdmission, constructorPreviewSlots, isSmallConstructorJob, createConstructorProbePool } from '@/lib/tools/baseConstructorCapacity';

const repoRoot = path.resolve(process.cwd(), '..');
const read = (name: string) => fs.readFileSync(path.join(repoRoot, name), 'utf8');

describe('BaseConstructor production capacity', () => {
  it('keeps every declared replica in deploy selection and shutdown handoff', () => {
    const services = Array.from(read('docker-compose.prod.yml').matchAll(/^  (worker-baseconstructor(?:-\d+)?):/gm), (match) => match[1]);
    const deploy = read('.semaphore/select-deploy-targets.sh').match(/ALL_WORKER_SERVICES="([\s\S]*?)"/)?.[1]?.split(/\s+/);
    const drain = read('drain-worker.sh').match(/bc_containers=\(\s*([\s\S]*?)\n\s*\)/)?.[1]?.split(/\s+/).map((token) => token.replace(/^"|"$/g, ''));
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(deploy).toContain(service);
      expect(drain).toContain(`portal-${service}`);
    }
  });

  it('bounds extra admission by memory and preserves the bulk slot under sustained preview load', () => {
    expect([undefined, '', 'bad', '-1', '1.5', '0', '1', '2', '100'].map(constructorPreviewSlots)).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 2]);
    expect(constructorAdmission(1, 1, 1, 2, 100, 1000)).toBe('small');
    expect(constructorAdmission(2, 1, 1, 2, 100, 1000)).toBe('small');
    expect(constructorAdmission(3, 1, 1, 2, 100, 1000)).toBeNull();
    expect(constructorAdmission(1, 1, 1, 2, 650, 1000)).toBeNull();
    expect(constructorAdmission(1, 1, 1, 2, 100, 0)).toBeNull();
    expect(constructorAdmission(1, 1, 1, 0, 100, 1000)).toBeNull();
    expect(constructorAdmission(2, 0, 1, 2, 100, 1000)).toBe('any');
    expect(constructorAdmission(2, 0, 1, 2, 650, 1000)).toBeNull();
  });

  it('admits only small validation jobs or known preview steps to extra slots', () => {
    const job = { initial_row_count: 100, selected_steps: ['find_emails', 'enrich_descriptions', 'split_emails', 'dedup_email', 'validate_emails'], step_config: { queue_class: 'interactive_preview' } };
    expect(isSmallConstructorJob(job)).toBe(true);
    expect(isSmallConstructorJob({ ...job, selected_steps: ['validate_emails'], step_config: {} })).toBe(true);
    for (const n of [undefined, 0, -1, 201, 25000, 1.5, '100']) expect(isSmallConstructorJob({ ...job, initial_row_count: n })).toBe(false);
    for (const steps of [[], null, ['ta_scoring'], ['validate_emails', 'personalize']]) expect(isSmallConstructorJob({ ...job, selected_steps: steps })).toBe(false);
    expect(isSmallConstructorJob({ ...job, step_config: {} })).toBe(false);
  });

  it('shares a bounded SMTP pool across jobs and releases failed probes', async () => {
    const run = createConstructorProbePool(20);
    let active = 0, highWater = 0;
    const calls = Array.from({ length: 60 }, (_, i) => run(async () => {
      active++; highWater = Math.max(highWater, active);
      await Promise.resolve(); active--;
      if (i % 7 === 0) throw new Error('temporary transport failure');
      return i;
    }));
    const results = await Promise.allSettled(calls);
    expect(highWater).toBe(20);
    expect(active).toBe(0);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(9);
    expect(results[59]).toEqual({ status: 'fulfilled', value: 59 });
    await expect(run(async () => 61)).resolves.toBe(61);
  });
});
