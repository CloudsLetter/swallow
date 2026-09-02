import { create } from "zustand";


interface GlobalState {
 settingShortcutsEnabled: boolean;
 toggleShortcuts: () => void;
}

 export const useGlobalState = create<GlobalState>((set) => ({
 settingShortcutsEnabled: true,
 toggleShortcuts: () =>
   set((state) => ({ settingShortcutsEnabled: !state.settingShortcutsEnabled })),
}));