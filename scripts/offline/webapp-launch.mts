/**
 * Offline cases for the panel's launch route memory: only a real Telegram Mini
 * App (non-empty initData) opens on the route the reader last visited; a
 * browser tab (web login or a public page, both with an empty initData) always
 * starts where it was asked to and never takes over the remembered route.
 *
 * Run: npx tsx scripts/offline/webapp-launch.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const store = new Map<string, string>();

// launch.ts reads window.location and localStorage lazily, so a minimal stand-in
// installed before the dynamic import is enough
Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
        location: { pathname: '/' },
        localStorage: {
            getItem: (key: string): string | null => store.get(key) ?? null,
            setItem: (key: string, value: string): void => {
                store.set(key, value);
            },
            removeItem: (key: string): void => {
                store.delete(key);
            },
        },
    },
});

const { captureLaunchState, launchRouteOf } = await import('../../webapp/src/launch.js');

interface FakeWebApp {
    initData: string;
    initDataUnsafe: { start_param?: string };
}

const results: CaseResult[] = [];

results.push(
    await runCase('the Telegram Mini App opens on the route it remembered', async () => {
        store.clear();
        store.set('lastRoute', '/c/123/conv');
        const launch = captureLaunchState({
            initData: 'query_id=AA&auth_date=1&hash=deadbeef',
            initDataUnsafe: {},
        });
        expect(launch.insideTelegram === true, 'a non-empty initData means the Mini App');
        expect(launch.savedRoute === '/c/123/conv', `the route is remembered (got ${launch.savedRoute})`);
        expect(
            launchRouteOf(launch, null) === '/c/123/conv',
            'with no start_param the launch lands on it'
        );
    })
);

results.push(
    await runCase('a browser tab never restores the remembered route', async () => {
        store.clear();
        store.set('lastRoute', '/c/123/conv');
        const launch = captureLaunchState({ initData: '', initDataUnsafe: {} });
        expect(launch.insideTelegram === false, 'an empty initData means the browser');
        expect(launch.savedRoute === null, 'the remembered route is not restored');
        expect(launchRouteOf(launch, null) === null, 'the browser opens where it was asked to');
    })
);

results.push(
    await runCase('a start_param still wins over the remembered route', async () => {
        store.clear();
        store.set('lastRoute', '/c/123/conv');
        const launch = captureLaunchState({
            initData: 'query_id=AA&auth_date=1&hash=deadbeef',
            initDataUnsafe: { start_param: 'slytoken' },
        });
        expect(launch.savedRoute === '/c/123/conv', 'the route is still read inside the Mini App');
        expect(
            launchRouteOf(launch, null) === null,
            'a start_param decides on its own: the remembered route is no fallback'
        );
        expect(
            launchRouteOf(launch, { kind: 'share', token: 'lytoken' }) === '/share/lytoken',
            'a start_param target replaces it'
        );
    })
);

reportResults(results);
