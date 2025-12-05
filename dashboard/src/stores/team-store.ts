import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Team } from '@grov/shared';

interface TeamState {
  // State
  currentTeamId: string | null;
  teams: Team[];

  // Actions
  setCurrentTeam: (teamId: string) => void;
  setTeams: (teams: Team[]) => void;
  addTeam: (team: Team) => void;
  updateTeam: (teamId: string, updates: Partial<Team>) => void;
  removeTeam: (teamId: string) => void;
  clearTeam: () => void;

  // Computed (via selectors)
  getCurrentTeam: () => Team | undefined;
}

export const useTeamStore = create<TeamState>()(
  persist(
    (set, get) => ({
      // Initial state
      currentTeamId: null,
      teams: [],

      // Actions
      setCurrentTeam: (teamId) => set({ currentTeamId: teamId }),

      setTeams: (teams) => {
        const state = get();
        set({ teams });

        // Auto-select first team if no current team
        if (!state.currentTeamId && teams.length > 0) {
          set({ currentTeamId: teams[0].id });
        }

        // Clear current team if it no longer exists
        if (state.currentTeamId && !teams.find(t => t.id === state.currentTeamId)) {
          set({ currentTeamId: teams.length > 0 ? teams[0].id : null });
        }
      },

      addTeam: (team) =>
        set((state) => ({
          teams: [...state.teams, team],
          currentTeamId: state.currentTeamId || team.id,
        })),

      updateTeam: (teamId, updates) =>
        set((state) => ({
          teams: state.teams.map((t) =>
            t.id === teamId ? { ...t, ...updates } : t
          ),
        })),

      removeTeam: (teamId) =>
        set((state) => {
          const newTeams = state.teams.filter((t) => t.id !== teamId);
          return {
            teams: newTeams,
            currentTeamId:
              state.currentTeamId === teamId
                ? newTeams.length > 0
                  ? newTeams[0].id
                  : null
                : state.currentTeamId,
          };
        }),

      clearTeam: () => set({ currentTeamId: null, teams: [] }),

      // Computed
      getCurrentTeam: () => {
        const state = get();
        return state.teams.find((t) => t.id === state.currentTeamId);
      },
    }),
    {
      name: 'grov-team-store',
      storage: createJSONStorage(() => localStorage),
      // Only persist currentTeamId - teams are fetched fresh
      partialize: (state) => ({ currentTeamId: state.currentTeamId }),
    }
  )
);

// Selector hooks for optimized re-renders
export const useCurrentTeamId = () => useTeamStore((state) => state.currentTeamId);
export const useTeams = () => useTeamStore((state) => state.teams);
export const useCurrentTeam = () =>
  useTeamStore((state) => state.teams.find((t) => t.id === state.currentTeamId));
