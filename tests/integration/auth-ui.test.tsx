import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PasswordInput } from '@/components/ui/password-input';

/**
 * The password field.
 *
 * Revealing a password matters more in this system than in most: staff type
 * long administrator-issued temporary passwords on phone keyboards at a
 * counter, and without a way to check what they typed they retry until they
 * give up or choose something short.
 */
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

describe('PasswordInput', () => {
  it('associates its label with the field', () => {
    render(<PasswordInput label="Password" name="password" />);

    const input = screen.getByLabelText('Password');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'password');
  });

  it('starts concealed', () => {
    render(<PasswordInput label="Password" name="password" />);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('reveals and conceals the password from the keyboard', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" name="password" />);

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);

    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    // The accessible name changes with the state, so a screen-reader user
    // knows whether their password is currently on screen.
    const pressed = screen.getByRole('button', { name: 'Hide password' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');

    await user.click(pressed);
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('is a real button, so it is reachable by keyboard', () => {
    render(<PasswordInput label="Password" name="password" />);

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.tagName).toBe('BUTTON');
    // Inside a form, a bare <button> would submit it.
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('keeps the toggle a usable touch target', () => {
    render(<PasswordInput label="Password" name="password" />);
    expect(screen.getByRole('button', { name: 'Show password' }).className).toContain(
      'min-h-touch',
    );
  });

  it('announces an error and marks the field invalid', () => {
    render(
      <PasswordInput
        label="Password"
        name="password"
        error="That is not your current password."
      />,
    );

    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('That is not your current password.');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
  });

  it('references its hint, so guidance is announced rather than decorative', () => {
    render(
      <PasswordInput label="Password" name="password" hint="At least 10 characters." />,
    );

    const input = screen.getByLabelText('Password');
    const hint = screen.getByText('At least 10 characters.');
    expect(input.getAttribute('aria-describedby')).toContain(hint.id);
  });

  it('gives two fields on one form distinct ids', () => {
    render(
      <>
        <PasswordInput label="Current password" name="currentPassword" error="A" />
        <PasswordInput label="New password" name="newPassword" error="B" />
      </>,
    );

    const first = screen
      .getByLabelText('Current password')
      .getAttribute('aria-describedby');
    const second = screen.getByLabelText('New password').getAttribute('aria-describedby');

    expect(first).not.toBe(second);
  });

  it('marks a required field accessibly', () => {
    render(<PasswordInput label="Password" name="password" required />);

    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toBeRequired();
  });
});
