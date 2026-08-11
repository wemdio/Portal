/**
 * Попап заметок и попап задач — один компонент с разным поведением.
 *
 * Заметки просили ускорить до «как комментарий в ячейке Google-таблицы»:
 * тыкнул и печатаешь, удалил одним кликом. Задачи трогать нельзя — они
 * уходят специалистам, и случайное удаление там необратимо. Тест держит
 * обе стороны этой границы.
 */
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ItemPopover } from '@/components/ProjectList';

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() }, from: jest.fn() },
}));

jest.mock('@/lib/UserProvider', () => ({
  useUser: () => ({ locale: 'ru', userRole: 'admin' }),
}));

const ITEMS = [{ id: 'note-1', title: 'запуск 10 августа' }];

function renderPopover(overrides: Record<string, unknown> = {}) {
  const onDelete = jest.fn();
  const setDeleteConfirmId = jest.fn();
  render(
    <ItemPopover
      items={ITEMS}
      title="Заметки"
      popoverRef={createRef<HTMLDivElement>()}
      pos={{ top: 100, left: 100, openUp: false }}
      canEdit
      deleteConfirmId={null}
      setDeleteConfirmId={setDeleteConfirmId}
      onDelete={onDelete}
      onClose={jest.fn()}
      newValue=""
      setNewValue={jest.fn()}
      onAdd={jest.fn()}
      placeholder="Новая заметка..."
      {...overrides}
    />,
  );
  return { onDelete, setDeleteConfirmId };
}

describe('ItemPopover — заметки', () => {
  it('ставит курсор в поле ввода сразу при открытии', () => {
    renderPopover({ autoFocusInput: true });
    expect(screen.getByPlaceholderText('Новая заметка...')).toHaveFocus();
  });

  it('удаляет одним кликом, без подтверждения', async () => {
    const { onDelete, setDeleteConfirmId } = renderPopover({ instantDelete: true });

    await userEvent.click(screen.getByTitle('Удалить'));

    expect(onDelete).toHaveBeenCalledWith('note-1');
    expect(setDeleteConfirmId).not.toHaveBeenCalled();
    expect(screen.queryByText('Да')).not.toBeInTheDocument();
  });

  it('показывает «Отменить» после удаления', async () => {
    const onUndo = jest.fn();
    renderPopover({
      instantDelete: true,
      items: [],
      renderUndo: (
        <div>
          <span>Заметка удалена</span>
          <button type="button" onClick={onUndo}>Отменить</button>
        </div>
      ),
    });

    expect(screen.getByText('Заметка удалена')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(onUndo).toHaveBeenCalled();
  });
});

describe('ItemPopover — задачи (поведение не меняется)', () => {
  it('не забирает фокус в поле ввода', () => {
    renderPopover({ placeholder: 'Новая задача...' });
    expect(screen.getByPlaceholderText('Новая задача...')).not.toHaveFocus();
  });

  it('удаляет только после подтверждения', async () => {
    const { onDelete, setDeleteConfirmId } = renderPopover({ placeholder: 'Новая задача...' });

    await userEvent.click(screen.getByTitle('Удалить'));

    expect(onDelete).not.toHaveBeenCalled();
    expect(setDeleteConfirmId).toHaveBeenCalledWith('note-1');
  });

  it('удаляет по кнопке «Да» в режиме подтверждения', async () => {
    const { onDelete } = renderPopover({ placeholder: 'Новая задача...', deleteConfirmId: 'note-1' });

    await userEvent.click(screen.getByText('Да'));

    expect(onDelete).toHaveBeenCalledWith('note-1');
  });
});
