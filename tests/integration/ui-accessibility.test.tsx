import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

/**
 * Accessibility assertions for the shared primitives.
 *
 * These are the behaviours Phase 2's forms will inherit, so getting them wrong
 * here would propagate into every screen. Each test asserts a property a
 * screen-reader or keyboard user depends on, not a class name.
 */
describe('Field', () => {
  it('associates the label with the input, so tapping the label focuses it', () => {
    render(<Field label="Phone number" name="phone" />);

    // getByLabelText only resolves when the association is real.
    const input = screen.getByLabelText('Phone number');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('references the hint from the input, so it is announced', () => {
    render(<Field label="Phone number" name="phone" hint="For example 0772 123 456" />);

    const input = screen.getByLabelText('Phone number');
    const hint = screen.getByText('For example 0772 123 456');

    expect(input.getAttribute('aria-describedby')).toContain(hint.id);
  });

  it('marks the input invalid and announces the error', () => {
    render(
      <Field
        label="Phone number"
        name="phone"
        error="Enter a valid Ugandan phone number."
      />,
    );

    const input = screen.getByLabelText('Phone number');
    // Colour alone is not perceivable; aria-invalid is.
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // role="alert" makes the message interrupt, so a failed submission is not
    // silently ignored by a screen reader.
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Enter a valid Ugandan phone number.');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
  });

  it('references both the hint and the error together', () => {
    render(
      <Field label="Amount" name="amount" hint="Whole shillings" error="Too low." />,
    );

    const describedBy = screen.getByLabelText('Amount').getAttribute('aria-describedby');
    expect(describedBy?.split(' ')).toHaveLength(2);
  });

  it('omits aria-describedby when there is nothing to describe', () => {
    render(<Field label="Amount" name="amount" />);
    expect(screen.getByLabelText('Amount')).not.toHaveAttribute('aria-describedby');
  });

  it('announces a required field in words, not just with an asterisk', () => {
    render(<Field label="Full name" name="fullName" required />);

    // The visual '*' is aria-hidden; the text alternative carries the meaning.
    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.getByLabelText(/Full name/)).toBeRequired();
  });

  it('gives each instance a unique id, so two fields never collide', () => {
    render(
      <>
        <Field label="First field" name="a" error="A" />
        <Field label="Second field" name="b" error="B" />
      </>,
    );

    const first = screen.getByLabelText('First field').getAttribute('aria-describedby');
    const second = screen.getByLabelText('Second field').getAttribute('aria-describedby');

    expect(first).not.toBe(second);
  });
});

describe('Button', () => {
  it('renders a real button element', () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    // Defaults to type="button" so it cannot submit a form by accident.
    expect(button).toHaveAttribute('type', 'button');
  });

  it('announces a pending state rather than only spinning', () => {
    render(<Button loading>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
  });

  it('is disabled when asked', () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps a 44px minimum touch target at every size', () => {
    // Staff use this one-handed at a counter; a "small" button is visually
    // tighter, never harder to hit.
    for (const size of ['sm', 'md', 'lg'] as const) {
      const { unmount } = render(<Button size={size}>Tap</Button>);
      expect(screen.getByRole('button').className).toContain('min-h-touch');
      unmount();
    }
  });

  it('can submit a form when told to', () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });
});

describe('Label', () => {
  it('links to its control and marks requirement accessibly', () => {
    render(
      <>
        <Label htmlFor="amount" required>
          Amount
        </Label>
        <Input id="amount" />
      </>,
    );

    expect(screen.getByLabelText(/Amount/)).toBeInTheDocument();
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });
});

describe('Input', () => {
  it('sets aria-invalid only when invalid', () => {
    const { unmount } = render(<Input aria-label="Amount" />);
    expect(screen.getByLabelText('Amount')).not.toHaveAttribute('aria-invalid');
    unmount();

    render(<Input aria-label="Amount" invalid />);
    expect(screen.getByLabelText('Amount')).toHaveAttribute('aria-invalid', 'true');
  });

  it('uses a 16px base font on small screens, to stop iOS zooming on focus', () => {
    render(<Input aria-label="Amount" />);
    expect(screen.getByLabelText('Amount').className).toContain('text-base');
  });
});

describe('Alert', () => {
  it('interrupts for a problem and waits for confirmation', () => {
    // A failure a screen-reader user misses is a failure they act on wrongly.
    const { unmount } = render(<Alert tone="danger">Payment failed.</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('Payment failed.');
    unmount();

    const { unmount: unmountWarning } = render(<Alert tone="warning">Check this.</Alert>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    unmountWarning();

    render(<Alert tone="success">Saved.</Alert>);
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('renders a title when given one', () => {
    render(
      <Alert tone="info" title="Not configured">
        Add your keys.
      </Alert>,
    );
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });
});

describe('Spinner', () => {
  it('conveys the loading state in text, not just animation', () => {
    render(<Spinner label="Loading clients" />);

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading clients');
  });
});

describe('Badge and Card', () => {
  it('states a badge meaning in words, not only in colour', () => {
    render(<Badge tone="danger">Overdue</Badge>);
    // Readable by a colour-blind user and in a printout.
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('renders a card heading at the requested level', () => {
    render(
      <Card>
        <CardHeader title="Company identity" description="From the database." as="h3" />
      </Card>,
    );

    expect(
      screen.getByRole('heading', { level: 3, name: 'Company identity' }),
    ).toBeInTheDocument();
    expect(screen.getByText('From the database.')).toBeInTheDocument();
  });

  it('defaults the card heading to h2', () => {
    render(<CardHeader title="Settings" />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Settings' }),
    ).toBeInTheDocument();
  });
});
