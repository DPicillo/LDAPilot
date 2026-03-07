import { useState, useEffect, useCallback } from 'react'
import { create } from 'zustand'
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react'
import { cn } from '../../lib/utils'

type ToastType = 'success' | 'error' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, message: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, message, duration = 4000) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    set((state) => ({
      toasts: [...state.toasts, { id, type, message, duration }],
    }));
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
}));

// Convenience functions
export const toast = {
  success: (msg: string) => useToastStore.getState().addToast('success', msg),
  error: (msg: string) => useToastStore.getState().addToast('error', msg, 6000),
  info: (msg: string) => useToastStore.getState().addToast('info', msg),
};

function ToastItem({ toast: t, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    if (t.duration) {
      const timer = setTimeout(onRemove, t.duration);
      return () => clearTimeout(timer);
    }
  }, [t.duration, onRemove]);

  const icons = {
    success: <CheckCircle size={14} className="text-green-400 shrink-0" />,
    error: <AlertCircle size={14} className="text-destructive shrink-0" />,
    info: <Info size={14} className="text-primary shrink-0" />,
  };

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 rounded shadow-lg border text-xs max-w-sm',
        'animate-in slide-in-from-right-full',
        'bg-card border-border text-card-foreground',
      )}
    >
      {icons[t.type]}
      <span className="flex-1">{t.message}</span>
      <button onClick={onRemove} className="p-0.5 text-muted-foreground hover:text-foreground shrink-0">
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-8 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  );
}
