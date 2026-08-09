import { resolveSurface } from '@/components/charts/theme';

describe('resolveSurface', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('берёт --chart-surface, если она объявлена', () => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'rgba(255, 255, 255, 0.55)';
    el.style.setProperty('--chart-surface', '#f4f6fa');
    document.body.appendChild(el);

    expect(resolveSurface(el)).toBe('#f4f6fa');
  });

  it('без переменной поднимается до первого непрозрачного предка', () => {
    const parent = document.createElement('div');
    parent.style.backgroundColor = 'rgb(255, 255, 255)';
    const child = document.createElement('div');
    parent.appendChild(child);
    document.body.appendChild(parent);

    expect(resolveSurface(child)).toBe('rgb(255, 255, 255)');
  });

  it('на голом дереве отдаёт белый', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    expect(resolveSurface(el)).toBe('#ffffff');
  });
});
