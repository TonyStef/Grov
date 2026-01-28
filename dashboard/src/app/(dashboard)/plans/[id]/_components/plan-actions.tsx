'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, CheckCircle2, Trash2 } from 'lucide-react';
import { updatePlan, deletePlan } from '../../actions';
import type { PlanStatus } from '@grov/shared';

interface PlanActionsProps {
  teamId: string;
  planId: string;
  status: PlanStatus;
}

export function PlanActions({ teamId, planId, status }: PlanActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleStatusChange = async (newStatus: PlanStatus) => {
    setLoading(newStatus);
    await updatePlan(teamId, planId, { status: newStatus });
    router.refresh();
    setLoading(null);
  };

  const handleDelete = async () => {
    setLoading('delete');
    await deletePlan(teamId, planId);
    router.push('/plans');
  };

  return (
    <div className="flex items-center gap-2">
      {status === 'active' && (
        <>
          <button
            onClick={() => handleStatusChange('completed')}
            disabled={loading !== null}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-success/10 text-success hover:bg-success/20 transition-all disabled:opacity-50"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {loading === 'completed' ? '...' : 'Complete'}
          </button>
          <button
            onClick={() => handleStatusChange('archived')}
            disabled={loading !== null}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-text-quiet/10 text-text-calm hover:bg-bark transition-all disabled:opacity-50"
          >
            <Archive className="h-3.5 w-3.5" />
            {loading === 'archived' ? '...' : 'Archive'}
          </button>
        </>
      )}

      {status === 'archived' && (
        <button
          onClick={() => handleStatusChange('active')}
          disabled={loading !== null}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-leaf/10 text-leaf hover:bg-leaf/20 transition-all disabled:opacity-50"
        >
          {loading === 'active' ? '...' : 'Reactivate'}
        </button>
      )}

      {showConfirm ? (
        <div className="flex items-center gap-1">
          <button
            onClick={handleDelete}
            disabled={loading === 'delete'}
            className="rounded-lg px-3 py-1.5 text-xs font-medium bg-error text-white hover:bg-error/80 transition-all disabled:opacity-50"
          >
            {loading === 'delete' ? '...' : 'Confirm'}
          </button>
          <button
            onClick={() => setShowConfirm(false)}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-text-calm hover:bg-bark transition-all"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowConfirm(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-error/70 hover:bg-error/10 hover:text-error transition-all"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      )}
    </div>
  );
}

