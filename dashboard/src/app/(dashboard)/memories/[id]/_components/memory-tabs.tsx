// Memory tabs component - Switches between Latest and History views
// Only rendered when memory has history (evolution_steps.length > 0)
'use client';

import { useState } from 'react';

interface MemoryTabsProps {
  latestContent: React.ReactNode;
  historyContent: React.ReactNode;
}

export function MemoryTabs({ latestContent, historyContent }: MemoryTabsProps) {
  const [activeTab, setActiveTab] = useState<'latest' | 'history'>('latest');

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-1 rounded-lg bg-bg-2 p-1">
        <button
          onClick={() => setActiveTab('latest')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'latest'
              ? 'bg-bg-1 text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          Latest
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'history'
              ? 'bg-bg-1 text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          History
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'latest' ? latestContent : historyContent}
    </div>
  );
}
