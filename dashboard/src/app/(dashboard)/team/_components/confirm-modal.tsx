'use client';

import { Loader2, X, AlertTriangle } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  isLoading?: boolean;
  variant?: 'danger' | 'warning';
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Confirm',
  isLoading = false,
  variant = 'danger',
}: ConfirmModalProps) {
  if (!isOpen) return null;

  const confirmButtonClass =
    variant === 'danger'
      ? 'bg-error hover:bg-error/90'
      : 'bg-warning hover:bg-warning/90';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-bg-0/80 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-md rounded-lg border border-border bg-bg-1 p-6 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-error/10">
            <AlertTriangle className="h-5 w-5 text-error" />
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">{title}</h2>
              <button
                onClick={onClose}
                className="rounded p-1 text-text-muted hover:bg-bg-2 hover:text-text-primary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-2 text-sm text-text-secondary">{description}</p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="rounded-md px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-2 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${confirmButtonClass}`}
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
