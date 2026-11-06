import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { match, P } from 'ts-pattern';
import { useBackButton } from './use-back-button';

/**
 * Logical parent of a page, so Back works the same whether the page was reached by
 * navigation, a start link or Telegram's "reload page".
 */
const parentPathOf = (pathname: string): string | null => {
    const segments = pathname.split('/').filter((segment) => segment !== '');
    return match(segments)
        .with([], () => null)
        .with(['c', P.string, P.string], ([, chatId]) => `/c/${chatId}`)
        .otherwise(() => '/');
};

/** Telegram's BackButton navigates to the parent page and is hidden on the chat list */
export const useNavigationBackButton = (): void => {
    const location = useLocation();
    const navigate = useNavigate();
    const parentPath = parentPathOf(location.pathname);

    const goToParent = useMemo(
        () => (parentPath === null ? null : () => void navigate(parentPath)),
        [parentPath, navigate]
    );
    useBackButton(goToParent);
};
