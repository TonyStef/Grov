// Sync command - Configure cloud sync settings

import {
  readCredentials,
  setTeamId,
  setSyncEnabled,
  getSyncStatus
} from '../lib/credentials.js';
import { fetchTeams } from '../lib/api-client.js';

export interface SyncOptions {
  enable?: boolean;
  disable?: boolean;
  team?: string;
  status?: boolean;
}

export async function sync(options: SyncOptions): Promise<void> {
  const creds = readCredentials();

  if (!creds) {
    console.log('Not logged in. Run "grov login" first.\n');
    process.exit(1);
  }

  // Show status
  if (options.status || (!options.enable && !options.disable && !options.team)) {
    const syncStatus = getSyncStatus();

    console.log('Cloud Sync Status\n');
    console.log(`  Logged in as: ${creds.email}`);
    console.log(`  Sync enabled: ${syncStatus?.enabled ? 'Yes' : 'No'}`);
    console.log(`  Team ID:      ${syncStatus?.teamId || 'Not set'}`);
    console.log('');

    if (!syncStatus?.enabled) {
      console.log('To enable sync:');
      console.log('  grov sync --enable --team <team-id>\n');
      console.log('To see available teams:');
      console.log('  grov sync --enable\n');
    }

    return;
  }

  // Disable sync
  if (options.disable) {
    setSyncEnabled(false);
    console.log('Cloud sync disabled.\n');
    console.log('Local memories will no longer be uploaded to your team.\n');
    return;
  }

  // Enable sync
  if (options.enable) {
    // Check if team is specified
    if (options.team) {
      setTeamId(options.team);
      setSyncEnabled(true);
      console.log(`Cloud sync enabled for team: ${options.team}\n`);
      console.log('Your memories will now be uploaded to your team dashboard.\n');
      return;
    }

    // No team specified - show available teams
    const currentStatus = getSyncStatus();

    if (currentStatus?.teamId) {
      // Team already set, just enable
      setSyncEnabled(true);
      console.log(`Cloud sync enabled for team: ${currentStatus.teamId}\n`);
      console.log('Your memories will now be uploaded to your team dashboard.\n');
      return;
    }

    // Need to select a team
    console.log('Fetching your teams...\n');

    try {
      const teams = await fetchTeams();

      if (teams.length === 0) {
        console.log('You are not a member of any teams.\n');
        console.log('Create a team at https://app.grov.dev or ask your team admin for an invite.\n');
        return;
      }

      console.log('Available teams:\n');
      console.log('  ID                                     Name');
      console.log('  ─────────────────────────────────────  ────────────────────');

      for (const team of teams) {
        console.log(`  ${team.id}  ${team.name}`);
      }

      console.log('');
      console.log('Enable sync with:');
      console.log(`  grov sync --enable --team <team-id>\n`);

      // If only one team, offer to use it
      if (teams.length === 1) {
        console.log(`Or, to use "${teams[0].name}":`);
        console.log(`  grov sync --enable --team ${teams[0].id}\n`);
      }
    } catch (err) {
      console.error(`Error fetching teams: ${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error('Please check your network connection and try again.\n');
      process.exit(1);
    }

    return;
  }

  // Just setting team (without enable flag)
  if (options.team) {
    setTeamId(options.team);
    console.log(`Team ID set to: ${options.team}\n`);

    const syncStatus = getSyncStatus();
    if (!syncStatus?.enabled) {
      console.log('Note: Sync is not enabled. Run "grov sync --enable" to start syncing.\n');
    }
  }
}
