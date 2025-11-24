// grov status - Show stored reasoning for current project

import { getTasksForProject, getTaskCount, getDatabasePath } from '../lib/store.js';

interface StatusOptions {
  all?: boolean;
}

export async function status(options: StatusOptions): Promise<void> {
  const projectPath = process.cwd();

  console.log('Grov Status');
  console.log('===========\n');

  console.log(`Project: ${projectPath}`);
  console.log(`Database: ${getDatabasePath()}\n`);

  // Get task count
  const totalCount = getTaskCount(projectPath);
  console.log(`Total tasks captured: ${totalCount}\n`);

  if (totalCount === 0) {
    console.log('No tasks captured yet for this project.');
    console.log('Tasks will be captured automatically as you use Claude Code.');
    return;
  }

  // Get tasks
  const tasks = getTasksForProject(projectPath, {
    status: options.all ? undefined : 'complete',
    limit: 10
  });

  console.log(`Showing ${options.all ? 'all' : 'completed'} tasks (most recent ${tasks.length}):\n`);

  for (const task of tasks) {
    console.log(`[${task.status.toUpperCase()}] ${truncate(task.original_query, 60)}`);
    console.log(`  ID: ${task.id.substring(0, 8)}...`);
    console.log(`  Created: ${formatDate(task.created_at)}`);

    if (task.files_touched.length > 0) {
      const fileList = task.files_touched
        .slice(0, 3)
        .map(f => f.split('/').pop())
        .join(', ');
      console.log(`  Files: ${fileList}${task.files_touched.length > 3 ? ` (+${task.files_touched.length - 3} more)` : ''}`);
    }

    if (task.tags.length > 0) {
      console.log(`  Tags: ${task.tags.join(', ')}`);
    }

    console.log('');
  }

  if (!options.all) {
    console.log('Use --all to see all tasks (including partial/abandoned).');
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString();
}
