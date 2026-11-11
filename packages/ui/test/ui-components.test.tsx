import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskChoiceKey } from '@/api/types';
import { Progress, progressShare } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { choiceForKey, OptionList, Segmented, type ChoiceOption } from '@/components/ui/choice';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { AppShell, NavItem, Sidebar, SidebarHeader, TopBar } from '@/components/ui/shell';
import { useShortcut } from '@/hooks/useShortcut';
import { isShortcut } from '@/lib/symbols';
import { DecisionAnswer } from '@/routes/tasks/decision-card';

const OPTIONS: readonly ChoiceOption[] = [
  { key: 'a', label: 'Email link only', recommended: true },
  { key: 'b', label: 'Email link and password' },
];

describe('an icon button', () => {
  it('is named by its label, and its tooltip adds the key', () => {
    render(<IconButton label="More" shortcut="." icon={<Ellipsis aria-hidden />} />);
    const button = screen.getByRole('button', { name: 'More' });
    expect(button.getAttribute('title')).toBe('More (.)');
  });
});

describe('a field', () => {
  it('labels its control, and marks a required one with an asterisk and as required', () => {
    render(
      <Field label="Title" required>
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /Title/ });
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.hasAttribute('required')).toBe(true);
    expect(screen.getByText('*').getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves a field that is not required unmarked', () => {
    render(
      <Field label="Labels">
        <Input />
      </Field>,
    );
    expect(screen.queryByText('*')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Labels' }).hasAttribute('aria-required')).toBe(false);
  });

  it('keeps its label on its control when the field is given an id, even if the control names another', () => {
    render(
      <Field id="task-title" label="Title">
        <Input id="something-else" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Title' });
    expect(input.id).toBe('task-title');
  });

  it('keeps the control of a required field required, whatever the control says', () => {
    render(
      <Field label="Title" required>
        <Input required={false} />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: /Title/ }).hasAttribute('required')).toBe(true);
  });

  it('keeps its label on a text area too, when the text area names another id', () => {
    render(
      <Field id="task-notes" label="Notes">
        <Textarea id="something-else" />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Notes' }).id).toBe('task-notes');
  });

  it('ties an error to its control', () => {
    render(
      <Field label="Email" error="This address has no @.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const said = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(said?.textContent).toBe('This address has no @.');
  });
});

describe('a menu', () => {
  function Actions({ onClaim, onPark }: { onClaim: () => void; onPark: () => void }) {
    return (
      <Menu>
        <MenuTrigger asChild>
          <button type="button">Actions</button>
        </MenuTrigger>
        <MenuContent label="Task web-a1">
          <MenuItem shortcut="M" onSelect={onClaim}>
            Claim
          </MenuItem>
          <MenuItem shortcut="Z" onSelect={onPark}>
            Park
          </MenuItem>
        </MenuContent>
      </Menu>
    );
  }

  it('opens on its first item and moves with the arrow keys', () => {
    render(<Actions onClaim={() => undefined} onPark={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu', { name: 'Task web-a1' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Claim/ }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Park/ }));
  });

  it('runs an item by its letter and closes', () => {
    const onPark = vi.fn();
    render(<Actions onClaim={() => undefined} onPark={onPark} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'z' });
    expect(onPark).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opened from the keyboard, puts focus back on its trigger when an item runs or Escape closes it', async () => {
    const onPark = vi.fn();
    render(<Actions onClaim={() => undefined} onPark={onPark} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    // Enter or Space on a focused button presses it.
    const open = () => {
      trigger.focus();
      fireEvent.click(trigger);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(trigger.getAttribute('aria-controls')).toBe(screen.getByRole('dialog').id);
    };

    open();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /Park/ }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'z' });
    expect(onPark).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('leaves focus where it went when it closes because focus moved out of it', async () => {
    render(
      <>
        <Actions onClaim={() => undefined} onPark={() => undefined} />
        <button type="button">Elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Focus would come back on the next task if it were coming back at all.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('ticks the value a picking menu holds, opens on it, and keeps a field for another value outside the menu', () => {
    render(
      <Menu>
        <MenuTrigger asChild>
          <button type="button">Priority</button>
        </MenuTrigger>
        <MenuContent label="Priority" footer={<input aria-label="Another" />}>
          <MenuItem checked={false}>Top</MenuItem>
          <MenuItem checked>High</MenuItem>
          <MenuItem checked={false}>Normal</MenuItem>
        </MenuContent>
      </Menu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    const menu = screen.getByRole('menu', { name: 'Priority' });
    const high = screen.getByRole('menuitemradio', { name: 'High' });
    expect(high.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Top' }).getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(high);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Normal' }));
    expect(menu.contains(screen.getByRole('textbox', { name: 'Another' }))).toBe(false);
  });
});

describe('choosing an option', () => {
  it('maps a letter, either case, to an option on offer and nothing else', () => {
    expect(choiceForKey('a', OPTIONS)).toBe('a');
    expect(choiceForKey('B', OPTIONS)).toBe('b');
    expect(choiceForKey('c', OPTIONS)).toBeNull();
    expect(choiceForKey('Enter', OPTIONS)).toBeNull();
  });

  it('answers in place with one press, naming each option by its letter', () => {
    const onChoose = vi.fn();
    render(<Segmented question="Which sign-in methods?" options={OPTIONS} onChoose={onChoose} />);
    fireEvent.click(screen.getByRole('button', { name: '(b) Email link and password' }));
    expect(onChoose).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: '(a) Email link only, recommended' })).toBeTruthy();
  });

  it('selects in the decision card by press or by letter', () => {
    function Card() {
      const [value, setValue] = useState<TaskChoiceKey | null>(null);
      return <OptionList question="Which sign-in methods?" options={OPTIONS} value={value} onChange={setValue} />;
    }
    render(<Card />);
    const group = screen.getByRole('radiogroup', { name: 'Which sign-in methods?' });
    fireEvent.keyDown(group, { key: 'b' });
    expect(screen.getByRole('radio', { name: '(b) Email link and password' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: /Email link only/ }));
    expect(screen.getByRole('radio', { name: /Email link only/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('draws a choice already made as a record: nothing to press, the chosen option marked', () => {
    render(<OptionList question="Which sign-in methods?" options={OPTIONS} value="b" readOnly />);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    const list = screen.getByRole('list', { name: 'Which sign-in methods?' });
    const chosen = list.querySelector('[data-choice-chosen]');
    expect(chosen?.getAttribute('data-choice-option')).toBe('b');
    expect(chosen?.getAttribute('aria-current')).toBe('true');
    expect(chosen?.textContent).toContain('Chosen');
  });

  it('answers on the card with the selected option, and with an option Enter is pressed on', () => {
    const onAnswer = vi.fn();
    function Card() {
      const [value, setValue] = useState<TaskChoiceKey | null>(null);
      const [note, setNote] = useState('');
      return (
        <DecisionAnswer
          choices={{ question: 'Which sign-in methods?', options: OPTIONS.map(({ key, label }) => ({ key, label })) }}
          value={value}
          onChange={setValue}
          note={note}
          onNote={setNote}
          onAnswer={onAnswer}
        />
      );
    }
    render(<Card />);
    const answer = screen.getByRole('button', { name: /Answer/ }) as HTMLButtonElement;
    // Nothing is selected yet, so nothing can be sent.
    expect(answer.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'b' });
    fireEvent.click(answer);
    expect(onAnswer).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(screen.getByRole('radio', { name: /Email link only/ }), { key: 'Enter' });
    expect(onAnswer).toHaveBeenLastCalledWith('a');
    expect(screen.getByRole('radio', { name: /Email link only/ }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('a page key', () => {
  it('runs on its key and leaves typing, modified presses and handled presses alone', () => {
    const action = vi.fn();
    renderHook(() => useShortcut('c', action));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'C' }));
    });
    expect(action).toHaveBeenCalledOnce();

    const input = document.createElement('input');
    document.body.append(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true }));
    });
    expect(action).toHaveBeenCalledOnce();
    input.remove();
  });

  it('treats a checkbox as no text field, and a named key as itself', () => {
    const root = document.createElement('div');
    root.setAttribute('data-ntasks', '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    root.append(box);
    const event = { key: 'c', altKey: false, ctrlKey: false, metaKey: false, defaultPrevented: false };
    expect(isShortcut({ ...event, target: box }, 'c')).toBe(true);
    expect(isShortcut({ ...event, key: 'Enter', target: null }, 'Enter')).toBe(true);
    expect(isShortcut({ ...event, key: 'e', target: null }, 'Enter')).toBe(false);
  });
});

describe('progress', () => {
  it('fills by the share done, and an empty total as none', () => {
    expect(progressShare(1, 4)).toBe(0.25);
    expect(progressShare(5, 4)).toBe(1);
    expect(progressShare(0, 0)).toBe(0);
    render(<Progress done={1} total={4} />);
    expect(screen.getByRole('img', { name: '1 of 4 done' })).toBeTruthy();
  });
});

describe('the frame on a phone', () => {
  function Frame() {
    return (
      <AppShell
        sidebar={
          <Sidebar aria-label="Pages">
            <NavItem href="#tasks" icon={null}>
              Tasks
            </NavItem>
            <NavItem href="#focus" icon={null}>
              Focus
            </NavItem>
          </Sidebar>
        }
      >
        <TopBar title="Tasks" />
      </AppShell>
    );
  }

  it('opens the sidebar from the top bar, with focus on its first link', () => {
    render(<Frame />);
    const opener = screen.getByRole('button', { name: 'Sidebar' });
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(opener.getAttribute('aria-controls')).toBe(nav.id);
    expect(nav.hasAttribute('data-open')).toBe(false);
    fireEvent.click(opener);
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(nav.hasAttribute('data-open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Tasks' }));
  });

  it('closes on Escape, a press outside it, a link inside it, and the browser going back', () => {
    render(<Frame />);
    const opener = screen.getByRole('button', { name: 'Sidebar' });
    const nav = screen.getByRole('navigation', { name: 'Pages' });

    fireEvent.click(opener);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.click(document.querySelector('[data-sidebar-backdrop]') as HTMLElement);
    expect(nav.hasAttribute('data-open')).toBe(false);

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('link', { name: 'Focus' }));
    expect(nav.hasAttribute('data-open')).toBe(false);
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(nav.hasAttribute('data-open')).toBe(false);
  });

  it('has no opener outside the frame', () => {
    render(<TopBar title="Tasks" />);
    expect(screen.queryByRole('button', { name: 'Sidebar' })).toBeNull();
  });
});

describe('the frame beside the page', () => {
  function Frame() {
    return (
      <div data-ntasks="">
        <AppShell
          sidebar={
            <Sidebar aria-label="Pages">
              <SidebarHeader icon={null} name="Example" />
              <NavItem href="#tasks" icon={null}>
                Tasks
              </NavItem>
            </Sidebar>
          }
        >
          <TopBar title="Tasks">
            <button type="button">New task</button>
          </TopBar>
        </AppShell>
      </div>
    );
  }

  /** Makes the window as wide as a laptop's, or as narrow as a phone's; the answer resizes it. */
  function screenWide(wide: boolean) {
    let now = wide;
    const changes = new Set<() => void>();
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          get matches() {
            return now && query === '(width >= 40rem)';
          },
          media: query,
          addEventListener: (_: string, onChange: () => void) => changes.add(onChange),
          removeEventListener: (_: string, onChange: () => void) => changes.delete(onChange),
        }) as unknown as MediaQueryList,
    );
    return (next: boolean) =>
      act(() => {
        now = next;
        for (const onChange of changes) onChange();
      });
  }

  function parts() {
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    return {
      nav,
      hide: within(nav).getByRole('button', { name: 'Sidebar' }),
      show: within(screen.getByRole('main')).getByRole('button', { name: 'Sidebar' }),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides from its header and shows again from the top bar, with focus on the button that stays', () => {
    screenWide(true);
    render(<Frame />);
    const { nav, hide, show } = parts();
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(hide.getAttribute('aria-controls')).toBe(nav.id);
    expect(show.getAttribute('aria-expanded')).toBe('true');

    hide.focus();
    fireEvent.click(hide);
    expect(nav.hasAttribute('data-collapsed')).toBe(true);
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(show);

    fireEvent.click(show);
    expect(nav.hasAttribute('data-collapsed')).toBe(false);
    // Beside the page the button shows the sidebar there, not as a sheet over the page.
    expect(nav.hasAttribute('data-open')).toBe(false);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(hide);
  });

  it('keeps the choice in the browser, and shows the sidebar where the browser refuses storage', () => {
    screenWide(true);
    const first = render(<Frame />);
    fireEvent.click(parts().hide);
    first.unmount();

    const second = render(<Frame />);
    expect(parts().nav.hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(parts().show);
    second.unmount();
    const third = render(<Frame />);
    expect(parts().nav.hasAttribute('data-collapsed')).toBe(false);
    third.unmount();

    window.localStorage.setItem('ntasks.sidebar', 'hidden');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    render(<Frame />);
    const { nav, hide } = parts();
    expect(nav.hasAttribute('data-collapsed')).toBe(false);
    fireEvent.click(hide);
    expect(nav.hasAttribute('data-collapsed')).toBe(true);
  });

  it('hides and shows on [, moving focus only out of the sidebar', () => {
    screenWide(true);
    render(<Frame />);
    const { nav, hide, show } = parts();
    const link = screen.getByRole('link', { name: 'Tasks' });
    link.focus();
    fireEvent.keyDown(link, { key: '[' });
    expect(nav.hasAttribute('data-collapsed')).toBe(true);
    expect(document.activeElement).toBe(show);

    const page = screen.getByRole('button', { name: 'New task' });
    page.focus();
    fireEvent.keyDown(page, { key: '[' });
    expect(nav.hasAttribute('data-collapsed')).toBe(false);
    expect(document.activeElement).toBe(page);
    fireEvent.keyDown(page, { key: '[' });
    expect(nav.hasAttribute('data-collapsed')).toBe(true);
    expect(document.activeElement).toBe(page);
    expect(hide.getAttribute('aria-expanded')).toBe('false');
  });

  it('on a phone, opens as a sheet from the top bar and on [, even when hidden from beside the page', () => {
    window.localStorage.setItem('ntasks.sidebar', 'hidden');
    screenWide(false);
    render(<Frame />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    // The sheet's own header has no Sidebar button, so its focus lands on its first link.
    expect(within(nav).queryByRole('button', { name: 'Sidebar' })).toBeNull();
    const show = screen.getByRole('button', { name: 'Sidebar' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(nav.hasAttribute('data-open')).toBe(true);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.hasAttribute('data-open')).toBe(false);

    fireEvent.keyDown(show, { key: '[' });
    expect(nav.hasAttribute('data-open')).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Tasks' }));
  });

  it('closes the sheet as the screen widens, and moves focus out of a sidebar kept hidden', () => {
    window.localStorage.setItem('ntasks.sidebar', 'hidden');
    const resize = screenWide(false);
    render(<Frame />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    const show = screen.getByRole('button', { name: 'Sidebar' });
    fireEvent.click(show);
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Tasks' }));

    resize(true);
    expect(nav.hasAttribute('data-open')).toBe(false);
    expect(nav.hasAttribute('data-collapsed')).toBe(true);
    expect(document.activeElement).toBe(show);
  });

  it('closes the sheet as the screen widens, leaving focus in a sidebar that shows', () => {
    const resize = screenWide(false);
    render(<Frame />);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar' }));
    const link = screen.getByRole('link', { name: 'Tasks' });
    expect(document.activeElement).toBe(link);

    resize(true);
    expect(nav.hasAttribute('data-open')).toBe(false);
    expect(nav.hasAttribute('data-collapsed')).toBe(false);
    expect(document.activeElement).toBe(link);
  });
});
