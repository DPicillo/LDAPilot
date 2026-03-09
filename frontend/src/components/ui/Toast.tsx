import { useState, useEffect, useCallback } from 'react'
import { create } from 'zustand'
import { X, CheckCircle, AlertCircle, Info, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  detail?: string;
  duration?: number;
  timestamp: number;
}

interface ToastState {
  toasts: Toast[];
  history: Toast[];
  addToast: (type: ToastType, message: string, options?: { duration?: number; detail?: string }) => void;
  removeToast: (id: string) => void;
  clearHistory: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  history: [],
  addToast: (type, message, options) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    const duration = options?.duration ?? (type === 'error' ? 0 : 4000); // errors don't auto-dismiss
    const entry: Toast = { id, type, message, detail: options?.detail, duration, timestamp: Date.now() };
    set((state) => ({
      toasts: [...state.toasts, entry],
      history: [entry, ...state.history].slice(0, 200),
    }));
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
  clearHistory: () => set({ history: [] }),
}));

// Convenience functions
export const toast = {
  success: (msg: string) => useToastStore.getState().addToast('success', msg),
  error: (msg: string, detail?: string) => useToastStore.getState().addToast('error', msg, { detail }),
  info: (msg: string) => useToastStore.getState().addToast('info', msg),
};

function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (t.duration && t.duration > 0) {
      const timer = setTimeout(onRemove, t.duration);
      return () => clearTimeout(timer);
    }
  }, [t.duration, onRemove]);

  const handleCopy = useCallback(() => {
    const text = t.detail ? `${t.message}\n\n${t.detail}` : t.message;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [t.message, t.detail]);

  const icons = {
    success: <CheckCircle size={14} className="text-green-400 shrink-0 mt-0.5" />,
    error: <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />,
    info: <Info size={14} className="text-blue-400 shrink-0 mt-0.5" />,
  };

  const borderColors = {
    success: 'border-l-green-500',
    error: 'border-l-red-500',
    info: 'border-l-blue-500',
  };

  return (
    <div
      className={cn(
        'flex flex-col px-3 py-2 rounded-md shadow-lg border border-border text-xs max-w-sm',
        'animate-in slide-in-from-right-full',
        'bg-card text-card-foreground border-l-2',
        borderColors[t.type],
      )}
    >
      <div className="flex items-start gap-2">
        {icons[t.type]}
        <span className="flex-1 leading-relaxed">{t.message}</span>
        <div className="flex items-center gap-0.5 shrink-0">
          {t.type === 'error' && (
            <button
              onClick={handleCopy}
              className="p-0.5 text-muted-foreground hover:text-foreground"
              title="Copy error"
            >
              {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
            </button>
          )}
          {t.detail && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 text-muted-foreground hover:text-foreground"
              title={expanded ? 'Hide details' : 'Show details'}
            >
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}
          <button onClick={onRemove} className="p-0.5 text-muted-foreground hover:text-foreground">
            <X size={11} />
          </button>
        </div>
      </div>
      {expanded && t.detail && (
        <div className="mt-1.5 pt-1.5 border-t border-border/50">
          <pre className="text-[10px] text-muted-foreground font-mono whitespace-pre-wrap break-all leading-relaxed">
            {t.detail}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  const zoomLevel = useUIStore((s) => s.zoomLevel);

  if (toasts.length === 0) return null;

  // Inside the zoom wrapper, 'fixed' positioning is relative to the transformed
  // container, not the viewport. Compute the actual viewport dimensions in the
  // zoomed coordinate space so the toast stays anchored to the real bottom-right.
  const bottom = 32 / zoomLevel;
  const right = 16 / zoomLevel;

  return (
    <div
      className="fixed z-[100] flex flex-col gap-2"
      style={{
        bottom: `${bottom}px`,
        right: `${right}px`,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  );
}
