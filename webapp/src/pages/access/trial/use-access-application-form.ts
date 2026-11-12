import { useCallback, useMemo, useState } from 'react';
import { describeAccessApplicationCreateFailure } from '../../../api';
import type { AccessApplicationSummary } from '../../../api';
import type { SaveStatus } from '../../../components/save-bar';
import { useApi } from '../../../context/panel-context';
import {
    ACCESS_IDENTITY_MAX,
    ACCESS_PURPOSE_MAX,
    accessApplicationRequestOf,
    accessTextLength,
} from '../access-form-rules';

interface AccessApplicationFormOptions {
    onCreated: (application: AccessApplicationSummary) => void;
}

const missingFieldsOf = (identity: string, purpose: string): string[] => {
    const missing: string[] = [];
    if (identity === '') missing.push('你是谁');
    if (purpose === '') missing.push('你要做什么');
    return missing;
};

/** The two application fields and the POST; the form is valid once both are filled and within limits */
export const useAccessApplicationForm = ({ onCreated }: AccessApplicationFormOptions) => {
    const api = useApi();
    const [identity, setIdentity] = useState('');
    const [purpose, setPurpose] = useState('');
    const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

    const identityLength = useMemo(() => accessTextLength(identity), [identity]);
    const purposeLength = useMemo(() => accessTextLength(purpose), [purpose]);
    const identityTooLong = identityLength > ACCESS_IDENTITY_MAX;
    const purposeTooLong = purposeLength > ACCESS_PURPOSE_MAX;
    const request = useMemo(() => accessApplicationRequestOf({ identity, purpose }), [identity, purpose]);
    const missing = useMemo(() => missingFieldsOf(identity.trim(), purpose.trim()), [identity, purpose]);
    const dirty = identity.trim() !== '' || purpose.trim() !== '';
    const saving = saveStatus.kind === 'saving';

    const pendingHint = useMemo(() => {
        if (missing.length > 0) return `还需填写：${missing.join('、')}`;
        if (identityTooLong) return `「你是谁」超过 ${ACCESS_IDENTITY_MAX} 字`;
        if (purposeTooLong) return `「你要做什么」超过 ${ACCESS_PURPOSE_MAX} 字`;
        return null;
    }, [missing, identityTooLong, purposeTooLong]);

    const submit = useCallback(() => {
        if (request === null || saving) return;
        setSaveStatus({ kind: 'saving' });
        void api.createAccessApplication(request).then((result) => {
            if (!result.ok) {
                setSaveStatus({ kind: 'failed', view: describeAccessApplicationCreateFailure(result.failure) });
                return;
            }
            setSaveStatus({ kind: 'idle' });
            onCreated(result.data.application);
        });
    }, [request, saving, api, onCreated]);

    return {
        identity,
        setIdentity,
        identityLength,
        identityTooLong,
        purpose,
        setPurpose,
        purposeLength,
        purposeTooLong,
        dirty,
        valid: request !== null,
        saving,
        saveStatus,
        pendingHint,
        submit,
    };
};
