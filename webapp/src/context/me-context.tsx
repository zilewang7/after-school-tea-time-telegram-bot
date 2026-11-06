import { createContext, useContext } from 'react';
import type { MeResponse } from '../api';

export interface MeContextValue {
    me: MeResponse;
    // Re-fetches /api/me in the background, e.g. after a save changed what the chat list shows
    refreshMe: () => void;
}

export const MeContext = createContext<MeContextValue | null>(null);

export const useMe = (): MeContextValue => {
    const value = useContext(MeContext);
    if (value === null) throw new Error('MeContext is missing');
    return value;
};
