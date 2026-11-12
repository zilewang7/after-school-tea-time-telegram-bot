import { useParams } from 'react-router';

const APPLICATION_ID_PATTERN = /^\d{1,10}$/;

/** :applicationId from the route, or null when it is not a usable application id */
export const useAccessApplicationIdParam = (): number | null => {
    const { applicationId: rawApplicationId } = useParams();
    if (rawApplicationId === undefined || !APPLICATION_ID_PATTERN.test(rawApplicationId)) return null;
    const applicationId = Number(rawApplicationId);
    return applicationId >= 1 ? applicationId : null;
};
