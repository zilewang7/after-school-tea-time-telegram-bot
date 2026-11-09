import { useParams } from 'react-router';
import { NotFoundPage } from '../not-found-page';
import { SharePage } from './share-page';

/** /share/:token: the public read-only view of one share */
export const ShareRoute = () => {
    const { token } = useParams();
    if (token === undefined || token === '') return <NotFoundPage />;
    // Keyed so opening another share starts from a clean state
    return <SharePage key={token} token={token} />;
};
