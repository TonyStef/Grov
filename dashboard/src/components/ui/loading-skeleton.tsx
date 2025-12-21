import { cn } from '@/lib/utils';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-lg bg-bark',
        className
      )}
    />
  );
}

export function TeamPageSkeleton() {
  return (
    <div className="animate-grow-in space-y-8 p-8">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-9 w-48 rounded-xl" />
          <Skeleton className="h-5 w-96 rounded-lg" />
        </div>
        <Skeleton className="h-11 w-32 rounded-xl" />
      </div>

      <div className="rounded-2xl border border-border bg-root">
        <div className="flex items-center gap-4 border-b border-border px-6 py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>

        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border px-6 py-4 last:border-b-0"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
            <Skeleton className="h-6 w-16 rounded-lg" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="animate-grow-in space-y-8 p-8">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64 rounded-xl" />
        <Skeleton className="h-5 w-96 rounded-lg" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-border bg-root p-5"
          >
            <Skeleton className="h-4 w-24 mb-3" />
            <Skeleton className="h-10 w-20 rounded-xl" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3 rounded-2xl border border-border bg-root p-6">
          <Skeleton className="h-6 w-32 mb-5 rounded-lg" />
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        </div>
        <div className="lg:col-span-2 rounded-2xl border border-border bg-root p-6">
          <Skeleton className="h-6 w-32 mb-5 rounded-lg" />
          <div className="space-y-5">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="h-9 w-9 rounded-xl shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MemoriesListSkeleton() {
  return (
    <div className="animate-grow-in space-y-8 p-8">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-32 rounded-xl" />
        <Skeleton className="h-11 w-64 rounded-xl" />
      </div>

      <div className="space-y-4">
        {[...Array(5)].map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-border bg-root p-5"
          >
            <div className="flex items-start justify-between">
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-3/4 rounded-lg" />
                <Skeleton className="h-4 w-1/2 rounded-lg" />
              </div>
              <Skeleton className="h-6 w-20 rounded-lg" />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <Skeleton className="h-6 w-6 rounded-lg" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MemoryDetailSkeleton() {
  return (
    <div className="animate-grow-in space-y-8 p-8">
      <div className="space-y-4">
        <Skeleton className="h-9 w-3/4 rounded-xl" />
        <Skeleton className="h-5 w-1/2 rounded-lg" />
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="rounded-2xl border border-border bg-root p-6">
            <Skeleton className="h-6 w-32 mb-5 rounded-lg" />
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-2xl border border-border bg-root p-6">
            <Skeleton className="h-6 w-24 mb-5 rounded-lg" />
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
