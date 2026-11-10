import { useParams } from 'react-router';
import { NotFoundPage } from '../not-found-page';
import { ThinkingPage } from './thinking-page';

/** /think/:token: the public read-only view of one long CoT link */
export const ThinkingRoute = () => {
    const { token } = useParams();
    if (token === undefined || token === '') return <NotFoundPage />;
    // Keyed so opening another thinking link starts from a clean state
    return <ThinkingPage key={token} token={token} />;
};
