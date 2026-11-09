import { useCallback } from 'react';
import type { PublicShareResponse } from '../api';
import { useApi } from '../context/panel-context';
import { useApiQuery } from './use-api-query';
import type { ApiQuery } from './use-api-query';

/** GET /api/public/shares/:token; no initData, so it answers anyone holding the link */
export const usePublicShare = (token: string): ApiQuery<PublicShareResponse> => {
    const api = useApi();
    const loadShare = useCallback((signal: AbortSignal) => api.getPublicShare(token, signal), [api, token]);
    return useApiQuery(loadShare);
};
