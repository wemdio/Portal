import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';

const db = createClient(
  'https://whhkkmfcmstawodnghzw.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoaGtrbWZjbXN0YXdvZG5naHp3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjUzODEwOCwiZXhwIjoyMDgyMTE0MTA4fQ.DLCzyTF-yRX57MFT_xHKPXcl3xsuPUACGARWnVi5i6k'
);

const outDir = '../temp-transcripts';
mkdirSync(outDir, { recursive: true });

const { data } = await db
  .from('tg_video_transcripts')
  .select('id,filename,sender_name,duration_seconds,text,created_at')
  .eq('status', 'completed')
  .in('sender_name', ['Егор Polza Agency', 'Александр'])
  .order('created_at', { ascending: true });

const unique = new Map();
data?.forEach(r => {
  const key = r.filename + '|' + r.sender_name;
  if (!unique.has(key)) unique.set(key, r);
});

const transcripts = [...unique.values()];
console.log(`Found ${transcripts.length} unique transcripts`);

const index = transcripts.map((t, i) => ({
  idx: i,
  id: t.id,
  filename: t.filename,
  sender: t.sender_name,
  duration_min: Math.round(t.duration_seconds / 60),
  chars: t.text?.length || 0,
  date: t.created_at?.split('T')[0],
}));

writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 2));

for (const t of transcripts) {
  const i = transcripts.indexOf(t);
  const safe = t.filename.replace(/[^a-zA-Z0-9а-яА-Я._-]/g, '_').slice(0, 80);
  const fname = `${outDir}/${String(i).padStart(2, '0')}_${safe}.txt`;
  writeFileSync(fname, t.text || '');
  console.log(`${i}: ${t.sender_name} | ${t.filename} | ${(t.text?.length || 0)} chars`);
}

console.log(`\nExported ${transcripts.length} files to ${outDir}/`);
