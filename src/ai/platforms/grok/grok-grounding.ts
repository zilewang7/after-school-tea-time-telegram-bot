/**
 * The sources one Grok response cites: url_citation annotations on its
 * output text plus xAI's top-level `citations` list, one entry per URL.
 */
import type { Response } from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';
import type { GroundingCitation, GroundingData } from '../../types.js';
import { fieldOf, listOf } from './grok-response-fields.js';

const annotationCitations = (response: Response): GroundingCitation[] =>
    listOf(response.output)
        .filter((item) => fieldOf(item, 'type') === 'message')
        .flatMap((item) => listOf(fieldOf(item, 'content')))
        .filter((content) => fieldOf(content, 'type') === 'output_text')
        .flatMap((content) => listOf(fieldOf(content, 'annotations')))
        .flatMap((annotation) => {
            if (!isJsonObject(annotation) || annotation.type !== 'url_citation') return [];
            const { url, title } = annotation;
            if (typeof url !== 'string' || !url) return [];
            return [{ uri: url, title: typeof title === 'string' ? title : undefined }];
        });

const listedCitations = (response: Response): GroundingCitation[] =>
    listOf(fieldOf(response, 'citations')).flatMap((citation) =>
        typeof citation === 'string' && citation ? [{ uri: citation }] : []
    );

export const extractGrokGrounding = (response: Response): GroundingData[] => {
    const citations = new Map<string, GroundingCitation>();

    // An annotation carries a title; a bare listed URL never replaces it
    for (const citation of annotationCitations(response)) {
        citations.set(citation.uri, citation);
    }
    for (const citation of listedCitations(response)) {
        if (!citations.has(citation.uri)) {
            citations.set(citation.uri, citation);
        }
    }

    if (!citations.size) {
        return [];
    }

    return [
        {
            provider: 'xai',
            searchQueries: [],
            citations: [...citations.values()],
        },
    ];
};
