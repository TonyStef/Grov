// Files touched component - Shows files modified during the task

interface FilesTouchedProps {
  files: string[];
}

// Get file extension for syntax highlighting
function getFileExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

// File type colors
const extensionColors: Record<string, string> = {
  ts: 'text-blue-400',
  tsx: 'text-blue-400',
  js: 'text-yellow-400',
  jsx: 'text-yellow-400',
  py: 'text-green-400',
  rb: 'text-red-400',
  go: 'text-cyan-400',
  rs: 'text-orange-400',
  java: 'text-orange-500',
  css: 'text-purple-400',
  scss: 'text-pink-400',
  html: 'text-orange-400',
  json: 'text-yellow-500',
  md: 'text-text-secondary',
  sql: 'text-blue-300',
  sh: 'text-green-300',
};

export function FilesTouched({ files }: FilesTouchedProps) {
  if (files.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-1 p-4">
        <h3 className="mb-3 font-medium text-text-primary">Files Touched</h3>
        <p className="text-sm text-text-muted">No files modified.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-bg-1 p-4">
      <h3 className="mb-3 font-medium text-text-primary">
        Files Touched
        <span className="ml-2 text-sm font-normal text-text-muted">
          ({files.length})
        </span>
      </h3>

      <ul className="space-y-1.5 max-h-64 overflow-y-auto">
        {files.map((file, index) => {
          const ext = getFileExtension(file);
          const color = extensionColors[ext] || 'text-text-secondary';

          return (
            <li
              key={index}
              className="flex items-center gap-2 text-sm"
            >
              <svg
                className={`h-4 w-4 flex-shrink-0 ${color}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <span className={`font-mono text-xs truncate ${color}`} title={file}>
                {file}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
