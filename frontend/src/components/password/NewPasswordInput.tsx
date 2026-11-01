import { useId, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Input } from '../ui/Input'

/**
 * Whether a new password with an optional confirmation can be written:
 * not empty and, with a confirmation field, typed the same twice.
 */
export function newPasswordReady(value: string, confirm: string | undefined): boolean {
  return value.length > 0 && (confirm === undefined || value === confirm);
}

/**
 * Input for a new password: masked, with a show/hide toggle and, when
 * `confirm` is given, a second field that must match (a typo would replace
 * the stored password with an unknown one). Enter calls onSubmit only when
 * the fields are ready; Escape calls onCancel.
 */
export function NewPasswordInput({
  value, onChange, confirm, onConfirmChange, onSubmit, onCancel, placeholder = 'New password', autoFocus, className, inputClassName, size = 'sm', id, 'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Confirmation value; undefined = no confirmation field */
  confirm?: string;
  onConfirmChange?: (v: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  /** Extra classes for the input fields. */
  inputClassName?: string;
  /** sm (22px, tables) or md (26px, dialogs). */
  size?: 'sm' | 'md';
  /** Id of the first field (a Field label points here). */
  id?: string;
  'aria-label'?: string;
}) {
  const [show, setShow] = useState(false);
  const mismatchId = `pw${useId().replace(/:/g, '')}-mismatch`;
  const withConfirm = confirm !== undefined;
  const mismatch = withConfirm && confirm.length > 0 && confirm !== value;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
    if (e.key === 'Enter' && newPasswordReady(value, confirm)) {
      e.preventDefault();
      onSubmit?.();
    }
  };
  const toggle = (
    <button type="button"
      onClick={() => setShow(!show)}
      aria-label={show ? 'Hide password' : 'Show password'}
      aria-pressed={show}
      tabIndex={-1}
      className="inline-flex items-center justify-center size-4 rounded-xs text-muted-foreground hover:text-foreground"
    >
      {show ? <EyeOff size={12} strokeWidth={1.75} aria-hidden /> : <Eye size={12} strokeWidth={1.75} aria-hidden />}
    </button>
  );
  return (
    <div className={cn('space-y-1', className)}>
      <Input
        id={id}
        size={size}
        mono
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? (id ? undefined : placeholder)}
        autoComplete="new-password"
        spellCheck={false}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        className={inputClassName}
        suffix={toggle}
      />
      {withConfirm && (
        <Input
          id={`${mismatchId}-confirm`}
          size={size}
          mono
          type={show ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => onConfirmChange?.(e.target.value)}
          placeholder="Confirm password"
          aria-label="Confirm password"
          aria-describedby={mismatch ? mismatchId : undefined}
          invalid={mismatch}
          autoComplete="new-password"
          spellCheck={false}
          className={inputClassName}
          onKeyDown={onKeyDown}
        />
      )}
      {mismatch && <div id={mismatchId} className="text-xs text-destructive">The passwords do not match.</div>}
    </div>
  );
}
