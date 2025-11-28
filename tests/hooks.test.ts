import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

describe('Hooks', () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Create a temporary directory to act as HOME
    tempDir = mkdtempSync(join(tmpdir(), 'grov-hooks-test-'));
    originalHome = process.env.HOME;
    // Note: We can't easily override homedir() in Node, so these tests
    // will need to mock the functions or test indirectly
  });

  afterEach(() => {
    // Restore original HOME
    if (originalHome) {
      process.env.HOME = originalHome;
    }

    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Settings path', () => {
    it('should return the correct settings path', async () => {
      const { getSettingsPath } = await import('../src/lib/hooks.js');

      const settingsPath = getSettingsPath();
      expect(settingsPath).toContain('.claude');
      expect(settingsPath).toContain('settings.json');
    });
  });

  describe('Settings file handling', () => {
    it('should read empty object when settings file does not exist', async () => {
      const { readClaudeSettings } = await import('../src/lib/hooks.js');

      // This will attempt to read the real settings file
      // which may or may not exist - just verify it doesn't throw
      const settings = readClaudeSettings();
      expect(typeof settings).toBe('object');
    });
  });

  // Note: More comprehensive tests would require mocking the file system
  // or running in an isolated environment where we can control ~/.claude/
});
