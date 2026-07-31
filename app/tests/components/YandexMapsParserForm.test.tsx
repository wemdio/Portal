import { fireEvent, render, screen } from '@testing-library/react';
import { YandexMapsParserForm } from '@/components/parsers/YandexMapsParserForm';

describe('YandexMapsParserForm', () => {
  it('submits 5000 results for the reported eight cities and delivery category', () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);

    const cities = [
      'Москва',
      'Королёв',
      'Люберцы',
      'Воскресенск',
      'Чехов',
      'Клин',
      'Лобня',
      'Дубна',
    ];
    cities.forEach((city) => fireEvent.click(screen.getByText(city)));
    fireEvent.click(screen.getByText('Доставка еды'));

    fireEvent.change(screen.getByRole('spinbutton'), {
      target: { value: '5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить парсинг' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_results: 5000,
      search_urls: expect.arrayContaining(
        cities.map((city) => (
          `https://yandex.ru/maps/?text=${encodeURIComponent(`${city} Доставка еды`)}`
        )),
      ),
    }));
    expect(onCreate.mock.calls[0][0].search_urls).toHaveLength(8);
  });
});
