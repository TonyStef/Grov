// Parse Codex apply_patch format to extract file operations

export interface PatchOperation {
  type: 'add' | 'update' | 'delete';
  file: string;
  moveTo?: string;
}

export interface PatchInfo {
  files: string[];
  operations: PatchOperation[];
  hasAdd: boolean;
  hasDelete: boolean;
}

const ADD_FILE_PREFIX = '*** Add File: ';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const MOVE_TO_PREFIX = '*** Move to: ';

export function parsePatchContent(patchText: string): PatchInfo {
  const files: string[] = [];
  const operations: PatchOperation[] = [];
  let hasAdd = false;
  let hasDelete = false;
  let currentOp: PatchOperation | null = null;

  for (const line of patchText.split('\n')) {
    if (line.startsWith(ADD_FILE_PREFIX)) {
      const file = line.slice(ADD_FILE_PREFIX.length).trim();
      files.push(file);
      hasAdd = true;
      currentOp = { type: 'add', file };
      operations.push(currentOp);
    } else if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const file = line.slice(UPDATE_FILE_PREFIX.length).trim();
      files.push(file);
      currentOp = { type: 'update', file };
      operations.push(currentOp);
    } else if (line.startsWith(DELETE_FILE_PREFIX)) {
      const file = line.slice(DELETE_FILE_PREFIX.length).trim();
      files.push(file);
      hasDelete = true;
      currentOp = { type: 'delete', file };
      operations.push(currentOp);
    } else if (line.startsWith(MOVE_TO_PREFIX) && currentOp) {
      const moveTo = line.slice(MOVE_TO_PREFIX.length).trim();
      currentOp.moveTo = moveTo;
      files.push(moveTo);
    }
  }

  return { files: [...new Set(files)], operations, hasAdd, hasDelete };
}
