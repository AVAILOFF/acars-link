import type { ReactNode } from 'react';

/**
 * A native checkbox drawn as a switch (design/spec.md §4); the whole row is its label. A disabled
 * one dims the whole row (U-13); `after` goes before the switch (the "saved" mark, U-08).
 */
export function Switch({
  checked,
  disabled,
  onChange,
  children,
  hint,
  after,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  after?: ReactNode;
}) {
  return (
    <label className={disabled === true ? 'sheet-row switch-row off' : 'sheet-row switch-row'}>
      <span className="row-text">
        <span className="row-title">{children}</span>
        {hint !== undefined && <span className="row-hint">{hint}</span>}
      </span>
      {after}
      <input
        type="checkbox"
        role="switch"
        className="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

/** The bare switch, for a row that has other controls too (then give it `id` or a label). */
export function SwitchInput({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id?: string;
  label?: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className="switch"
      aria-label={label}
      aria-checked={checked}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
}
