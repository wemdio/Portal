/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

describe('Telegram transcription job heartbeat', () => {
  it('persists worker and local Whisper progress while a job is running', () => {
    const worker = fs.readFileSync(
      path.resolve(process.cwd(), 'worker/tgTranscribe.ts'),
      'utf8',
    );
    const health = fs.readFileSync(
      path.resolve(process.cwd(), '../services/health-check/main.py'),
      'utf8',
    );

    expect(worker).toContain('getLocalTranscriptionProgress(transcriptionJobId)');
    expect(worker).toContain('monitor_progress: monitorProgress');
    expect(worker).toContain(".eq('status', 'running')");
    expect(worker).toContain('TG_TRANSCRIBE_JOB_HEARTBEAT_MS');
    expect(health).toContain("'{monitor_progress,progress_percent}'");
  });
});
