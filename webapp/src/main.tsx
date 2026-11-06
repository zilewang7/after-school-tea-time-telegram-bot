import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { OutsideTelegram } from './components/outside-telegram';
import { captureLaunchState } from './launch';
import { createAppRouter } from './router';
import { getTelegramWebApp } from './telegram';
import { startThemeSync } from './theme';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('#root is missing from index.html');
const root = createRoot(rootElement);

const webApp = getTelegramWebApp();
if (webApp === null) {
    root.render(
        <StrictMode>
            <OutsideTelegram />
        </StrictMode>
    );
} else {
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
}
