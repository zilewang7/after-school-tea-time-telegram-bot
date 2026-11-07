import { useCallback } from 'react';
import type { ChangeEvent } from 'react';
import type { IssueDetail, IssueSeverity } from '../../../api';
import { ChoiceChips } from '../../../components/choice-chips';
import type { ChoiceOption } from '../../../components/choice-chips';
import { LengthCounter } from '../../../components/length-counter';
import { SaveBar } from '../../../components/save-bar';
import { ISSUE_KIND_OPTIONS, ISSUE_SEVERITY_OPTIONS } from '../../../issues/issue-labels';
import { ISSUE_BODY_MAX, ISSUE_TITLE_MAX } from '../../../issues/issue-text';
import { useIssueForm } from './use-issue-form';

const SEVERITY_FORM_OPTIONS: readonly ChoiceOption<IssueSeverity | null>[] = [
    { value: null, label: '不指定' },
    ...ISSUE_SEVERITY_OPTIONS,
];

interface IssueFormProps {
    chatId: number;
    // Group chats get a notice from the bot naming the person who filed it
    showGroupNotice: boolean;
    onCreated: (issue: IssueDetail) => void;
}

export const IssueForm = ({ chatId, showGroupNotice, onCreated }: IssueFormProps) => {
    const form = useIssueForm({ chatId, onCreated });
    const { setTitle, setBody } = form;
    // Frozen while submitting, like the settings forms
    const disabled = form.saving;

    const handleTitleInput = useCallback((event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value), [setTitle]);
    const handleBodyInput = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setBody(event.target.value), [setBody]);

    return (
        <section className="section">
            {form.restoredFromDraft && <p className="notice">已恢复未保存的草稿</p>}

            <div className="field-group">
                <span className="field-label">类型</span>
                <ChoiceChips
                    label="类型"
                    options={ISSUE_KIND_OPTIONS}
                    selected={form.kind}
                    disabled={disabled}
                    onSelect={form.setKind}
                />
            </div>

            <div className="field-group">
                <span className="field-label">
                    严重程度 <span className="hint">可选</span>
                </span>
                <ChoiceChips
                    label="严重程度"
                    options={SEVERITY_FORM_OPTIONS}
                    selected={form.severity}
                    disabled={disabled}
                    onSelect={form.setSeverity}
                />
            </div>

            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="issue-title" className="field-label">
                        标题
                    </label>
                    <LengthCounter length={form.titleLength} max={ISSUE_TITLE_MAX} />
                </div>
                <input
                    id="issue-title"
                    className="field"
                    type="text"
                    value={form.title}
                    disabled={disabled}
                    placeholder="一句话说清楚问题"
                    onChange={handleTitleInput}
                />
                {showGroupNotice && <p className="hint">标题会连同你的名字发到本群</p>}
            </div>

            <div className="field-group">
                <div className="field-label-row">
                    <label htmlFor="issue-body" className="field-label">
                        正文
                    </label>
                    <LengthCounter length={form.bodyLength} max={ISSUE_BODY_MAX} />
                </div>
                <textarea
                    id="issue-body"
                    className="field issue-text-input"
                    value={form.body}
                    disabled={disabled}
                    rows={8}
                    placeholder="发生了什么、期望是什么、怎么复现"
                    onChange={handleBodyInput}
                />
            </div>

            <SaveBar
                writable
                dirty={form.dirty}
                valid={form.valid}
                status={form.saveStatus}
                justSaved={false}
                savedMessage=""
                pendingHint={form.missingHint}
                actionLabel="提交"
                onSave={form.submit}
                onRefresh={null}
            />
        </section>
    );
};
