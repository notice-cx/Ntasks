import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskChoiceKey } from '@/api/types';
import { Progress, progressShare } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { choiceForKey, OptionList, Segmented, type ChoiceOption } from '@/components/ui/choice';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { AppShell, NavItem, Sidebar, TopBar } from '@/components/ui/shell';
import { useShortcut } from '@/hooks/useShortcut';
import { isShortcut } from '@/lib/symbols';

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
    const box = document.createElement('input');
    box.type = 'checkbox';
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
