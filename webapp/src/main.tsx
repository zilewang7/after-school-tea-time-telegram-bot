import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createApi } from './api';
import { createBrowserWebApp } from './browser-web-app';
import { captureLaunchState } from './launch';
import { BootErrorPage } from './pages/web-login/boot-error-page';
import { WebLoginPage } from './pages/web-login/web-login-page';
import { createAppRouter } from './router';
import { getTelegramWebApp, type TelegramWebApp } from './telegram';
import { startThemeSync } from './theme';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('#root is missing from index.html');
const root = createRoot(rootElement);

const startPanel = (webApp: TelegramWebApp): void => {
    startThemeSync(webApp);
    // Captured before the first render, which starts overwriting lastRoute
    const router = createAppRouter(captureLaunchState(webApp));
    root.render(
        <StrictMode>
            <App webApp={webApp} router={router} />
        </StrictMode>
    );
    webApp.ready();
    webApp.expand();
};

const renderLogin = (): void => {
    root.render(
        <StrictMode>
            <WebLoginPage />
        </StrictMode>
    );
};

const renderBootError = (): void => {
    root.render(
        <StrictMode>
            <BootErrorPage onRetry={() => window.location.reload()} />
        </StrictMode>
    );
};

/**
 * Outside Telegram (design §8.1): a session cookie or the login page decides.
 * `getTelegramWebApp` returns null both without the SDK and with an empty
 * initData, which is exactly the browser case.
 */
const bootstrapBrowser = async (): Promise<void> => {
    // A share link is public read-only content: no session, no login page
    if (window.location.pathname.startsWith('/share/')) {
        startPanel(createBrowserWebApp());
        return;
    }
    const result = await createApi('').getMe();
    if (result.ok) {
        startPanel(createBrowserWebApp());
        return;
    }
    if (result.failure.kind === 'http' && result.failure.status === 401) {
        renderLogin();
        return;
    }
    renderBootError();
};

const webApp = getTelegramWebApp();
if (webApp !== null) {
    startPanel(webApp);
} else {
    void bootstrapBrowser();
}
