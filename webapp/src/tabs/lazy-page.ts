import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * React.lazy for a named export (the panel has no default exports): the page
 * becomes its own chunk, loaded the first time it renders.
 *
 *     const IssuePage = lazyPage(() => import('./pages/issue-page'), 'IssuePage');
 */
export const lazyPage = <TName extends string, TModule extends Record<TName, ComponentType>>(
    load: () => Promise<TModule>,
    name: TName
): LazyExoticComponent<TModule[TName]> => lazy(async () => ({ default: (await load())[name] }));
