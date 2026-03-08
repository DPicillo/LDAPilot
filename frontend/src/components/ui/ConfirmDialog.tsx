import { useEffect } from 'react'
import { AlertTriangle, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ConfirmDialogProps {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onCancel]);

  const Icon = variant === 'danger' ? Trash2 : AlertTriangle;
  const iconColor = variant === 'danger' ? 'text-red-400' : variant === 'warning' ? 'text-yellow-400' : 'text-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[400px] max-w-[90vw]"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div className={cn('p-2 rounded-full bg-background', iconColor)}>
              <Icon size={18} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold mb-1">{title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
              {detail && (
                <p className="text-xs text-muted-foreground/70 font-mono mt-1.5 break-all">{detail}</p>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
            autoFocus
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={cn(
              'text-xs px-3 py-1.5 rounded font-medium',
              variant === 'danger'
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
