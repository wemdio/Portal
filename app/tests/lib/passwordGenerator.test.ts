import { generateStrongPassword } from '@/lib/passwordGenerator';

describe('generateStrongPassword', () => {
  it('возвращает строку длиной по умолчанию 14', () => {
    expect(generateStrongPassword()).toHaveLength(14);
  });

  it('уважает кастомную длину', () => {
    expect(generateStrongPassword(20)).toHaveLength(20);
    expect(generateStrongPassword(8)).toHaveLength(8);
  });

  it('содержит хотя бы одну букву нижнего регистра', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[a-z]/);
    }
  });

  it('содержит хотя бы одну букву верхнего регистра', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[A-Z]/);
    }
  });

  it('содержит хотя бы одну цифру', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[0-9]/);
    }
  });

  it('содержит хотя бы один спецсимвол', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateStrongPassword()).toMatch(/[!@#$%^&*\-_+=]/);
    }
  });

  it('бросает ошибку на длину меньше 8', () => {
    expect(() => generateStrongPassword(7)).toThrow(/at least 8/i);
  });

  it('бросает ошибку на длину больше 72 (bcrypt cap)', () => {
    expect(() => generateStrongPassword(73)).toThrow(/at most 72/i);
  });

  it('не повторяется (две последовательные генерации различаются)', () => {
    expect(generateStrongPassword()).not.toBe(generateStrongPassword());
  });
});
