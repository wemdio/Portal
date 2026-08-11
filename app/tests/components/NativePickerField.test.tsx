/**
 * Поле даты в задачах: один клик — одно открытие календаря.
 *
 * Жалоба была «с первого раза дату не поставить, нужно нажимать несколько
 * раз». Причина — пара обработчиков onFocus + onClick на одном поле: клик
 * мышью порождает оба события подряд, календарь открывался дважды, и второй
 * вызов гасил уже открытый. Тест держит ровно это: showPicker должен
 * вызываться по одному разу на клик.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NativePickerField } from '@/components/tasks/NativePickerField';

type PickerInput = HTMLInputElement & { showPicker: jest.Mock };

let showPicker: jest.Mock;

beforeEach(() => {
  showPicker = jest.fn();
  // jsdom не реализует showPicker — подставляем свой, чтобы считать вызовы.
  (HTMLInputElement.prototype as unknown as PickerInput).showPicker = showPicker;
});

function renderField(props: Partial<React.ComponentProps<typeof NativePickerField>> = {}) {
  const onChange = jest.fn();
  render(
    <NativePickerField
      type="datetime-local"
      locale="ru"
      value=""
      onChange={onChange}
      className="field"
      placeholderRu="ДД.ММ.ГГГГ --:--"
      placeholderEn="MM/DD/YYYY --:--"
      {...props}
    />,
  );
  return { onChange, field: screen.getByPlaceholderText('ДД.ММ.ГГГГ --:--') };
}

it('открывает календарь один раз на один клик', async () => {
  const { field } = renderField();

  await userEvent.click(field);

  expect(showPicker).toHaveBeenCalledTimes(1);
});

it('не открывает календарь сам по себе, без клика', () => {
  renderField();

  expect(showPicker).not.toHaveBeenCalled();
});

it('открывает календарь с клавиатуры по Enter', async () => {
  const { field } = renderField();
  field.focus();

  await userEvent.keyboard('{Enter}');

  expect(showPicker).toHaveBeenCalledTimes(1);
});

it('показывает дату по-русски, а не как в разметке', () => {
  renderField({ value: '2026-08-11T14:30' });

  expect(screen.getByPlaceholderText('ДД.ММ.ГГГГ --:--')).toHaveValue('11.08.2026 14:30');
});
