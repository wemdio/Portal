/**
 * Короткий сигнал «готово» для долгих ИИ-генераций: пока ответ пишется
 * (до 30 секунд), менеджер уходит в другие окна и забывает вернуться.
 *
 * Браузер разрешает звук только после клика, поэтому primeChime() зовём в
 * обработчике нажатия, а playChime() — когда результат пришёл, даже если
 * вкладка уже в фоне. Без Web Audio (старый браузер) просто молчим.
 */
let ctx: AudioContext | null = null;

export function primeChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  } catch {
    ctx = null;
  }
}

/** done — две ноты вверх, error — две вниз, чтобы ошибку было слышно сразу. */
export function playChime(kind: 'done' | 'error' = 'done'): void {
  const audio = ctx;
  if (!audio) return;
  try {
    if (audio.state === 'suspended') void audio.resume().catch(() => {});
    const notes = kind === 'done' ? [660, 880] : [440, 330];
    const start = audio.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t = start + i * 0.14;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    // звук — не главное, генерация уже отработала
  }
}
