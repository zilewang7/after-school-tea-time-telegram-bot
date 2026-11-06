import { RouterProvider } from 'react-router/dom';
import { PanelProvider } from './context/panel-context';
import type { AppRouter } from './router';
import type { TelegramWebApp } from './telegram';

interface AppProps {
    webApp: TelegramWebApp;
    router: AppRouter;
}

export const App = ({ webApp, router }: AppProps) => (
    <PanelProvider webApp={webApp}>
        <RouterProvider router={router} />
    </PanelProvider>
);
