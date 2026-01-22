// Store module - barrel exports for backward compatibility

// Re-export all types
export type {
  TaskStatus,
  TriggerReason,
  SessionStatus,
  SessionMode,
  TaskType,
  StepActionType,
  DriftType,
  CorrectionLevel,
  Task,
  CreateTaskInput,
  RecoveryPlan,
  DriftEvent,
  SessionState,
  CreateSessionStateInput,
  StepRecord,
  CreateStepInput,
  DriftLogEntry,
  CreateDriftLogInput,
} from './types.js';

// Re-export database functions
export { initDatabase, closeDatabase, getDatabasePath } from './database.js';

// Re-export task functions
export {
  createTask,
  getTasksForProject,
  getTaskCount,
  getUnsyncedTasks,
  markTaskSynced,
  setTaskSyncError,
  getSyncedTaskCount,
  cleanupOldSyncedTasks,
  cleanupFailedSyncTasks
} from './tasks.js';

// Re-export session functions
export {
  createSessionState,
  getSessionState,
  updateSessionState,
  deleteSessionState,
  getActiveSessionForUser,
  getActiveSessionsForStatus,
  getCompletedSessionForProject,
  clearStalePendingCorrections,
  getOrphanedSessionCount,
  repairOrphanedSessions
} from './sessions.js';

// Re-export step functions
export {
  createStep,
  getStepsForSession,
  getRecentSteps,
  getValidatedSteps,
  getKeyDecisions,
  getEditedFiles,
  deleteStepsForSession,
  updateRecentStepsReasoning,
  updateLastChecked
} from './steps.js';

// Re-export drift functions
export { updateSessionDrift, logDriftEvent } from './drift.js';

// Re-export convenience functions
export {
  updateTokenCount,
  updateSessionMode,
  markWaitingForRecovery,
  incrementEscalation,
  markCleared,
  markSessionCompleted,
  cleanupOldCompletedSessions,
  cleanupStaleActiveSessions
} from './convenience.js';
