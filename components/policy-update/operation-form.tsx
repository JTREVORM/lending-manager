'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, SelectField } from '@/components/ui/field';
import { policyUpdateAction, type PolicyActionResult } from '@/lib/policy-update/actions';
import type { PolicyOperation } from '@/lib/validation/policy-update';

export interface OperationField {
  readonly name: string;
  readonly label: string;
  readonly type?: 'text' | 'date' | 'number';
  readonly required?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly hint?: string;
}

export function OperationForm({
  operation,
  values,
  fields = [],
  label,
  disabled = false,
}: {
  readonly operation: PolicyOperation['operation'];
  readonly values: Readonly<Record<string, string>>;
  readonly fields?: readonly OperationField[];
  readonly label: string;
  readonly disabled?: boolean;
}) {
  const [result, submit, pending] = useActionState<
    PolicyActionResult | undefined,
    FormData
  >(policyUpdateAction, undefined);
  return (
    <form action={submit} className="min-w-0 space-y-3">
      <input type="hidden" name="operation" value={operation} />
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {fields.map((field) =>
        field.options ? (
          <SelectField
            key={field.name}
            name={field.name}
            label={field.label}
            required={field.required}
            placeholder="Choose…"
            options={[...field.options]}
            error={result?.fieldErrors?.[field.name]?.[0]}
          />
        ) : (
          <Field
            key={field.name}
            name={field.name}
            label={field.label}
            type={field.type ?? 'text'}
            required={field.required}
            hint={field.hint}
            error={result?.fieldErrors?.[field.name]?.[0]}
          />
        ),
      )}
      {result ? (
        <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>
      ) : null}
      <Button type="submit" disabled={pending || disabled}>
        {pending ? 'Recording…' : label}
      </Button>
    </form>
  );
}
