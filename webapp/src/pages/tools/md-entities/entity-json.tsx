import { useMemo } from 'react';
import { CollapsibleSection } from '../../../components/collapsible-section';
import type { RenderedMarkdown } from '../../../tools/types';

interface EntityJsonProps {
    rendered: RenderedMarkdown;
}

/** Folded debug view: the rendered text and the Bot API entities */
export const EntityJson = ({ rendered }: EntityJsonProps) => {
    const json = useMemo(
        () => JSON.stringify({ text: rendered.text, entities: rendered.entities }, null, 2),
        [rendered]
    );
    return (
        <CollapsibleSection
            title="text + entities"
            summary={`${rendered.entities.length} 个实体 · ${rendered.text.length} 字符`}
        >
            <pre className="code-block">{json}</pre>
        </CollapsibleSection>
    );
};
