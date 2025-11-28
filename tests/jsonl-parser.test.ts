import { describe, it, expect } from 'vitest';
import { encodeProjectPath, decodeProjectPath, isPathWithinProject } from '../src/lib/jsonl-parser.js';

describe('encodeProjectPath', () => {
  it('should encode forward slashes as dashes', () => {
    expect(encodeProjectPath('/Users/dev/myapp')).toBe('-Users-dev-myapp');
  });

  it('should handle paths with multiple levels', () => {
    expect(encodeProjectPath('/Users/dev/projects/myapp/src')).toBe('-Users-dev-projects-myapp-src');
  });

  it('should handle paths with special characters', () => {
    expect(encodeProjectPath('/Users/dev/my-app')).toBe('-Users-dev-my-app');
  });

  it('should normalize double dots to single dot', () => {
    // Security: prevent encoding paths with traversal
    expect(encodeProjectPath('/Users/../etc')).toBe('-Users-.-etc');
  });
});

describe('decodeProjectPath', () => {
  it('should decode dashes back to forward slashes', () => {
    expect(decodeProjectPath('-Users-dev-myapp')).toBe('/Users/dev/myapp');
  });

  it('should throw on path traversal attempts', () => {
    expect(() => decodeProjectPath('-Users-..-etc-passwd')).toThrow('traversal sequence detected');
  });

  it('should handle paths with multiple levels', () => {
    expect(decodeProjectPath('-Users-dev-projects-myapp-src')).toBe('/Users/dev/projects/myapp/src');
  });
});

describe('isPathWithinProject', () => {
  it('should return true for paths within project', () => {
    expect(isPathWithinProject('/Users/dev/myapp', '/Users/dev/myapp/src/index.ts')).toBe(true);
  });

  it('should return true for exact project path', () => {
    expect(isPathWithinProject('/Users/dev/myapp', '/Users/dev/myapp')).toBe(true);
  });

  it('should return false for paths outside project', () => {
    expect(isPathWithinProject('/Users/dev/myapp', '/Users/dev/otherapp/src/index.ts')).toBe(false);
  });

  it('should return false for parent directory', () => {
    expect(isPathWithinProject('/Users/dev/myapp', '/Users/dev')).toBe(false);
  });

  it('should handle paths with trailing slashes', () => {
    expect(isPathWithinProject('/Users/dev/myapp/', '/Users/dev/myapp/src')).toBe(true);
  });

  it('should handle relative paths', () => {
    // These will be resolved relative to cwd, but the function should still work
    expect(isPathWithinProject('.', './src/index.ts')).toBe(true);
  });
});
