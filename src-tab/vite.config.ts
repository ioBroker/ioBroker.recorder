import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Loads socket.io from the admin, which serves its client at `lib/js/socket.io.js`. The tag is
 * added after the HTML transform: in `tab.html` itself vite would try to bundle the file.
 * The reload on error is the admin's convention for a tab opened while the admin starts.
 */
function adminSocketIo(): Plugin {
    return {
        name: 'recorder-admin-socket-io',
        transformIndexHtml: {
            order: 'post',
            handler(html: string): string {
                return html.replace(
                    '</head>',
                    '    <script type="text/javascript" onerror="setTimeout(function(){window.location.reload()}, 5000)" src="./../../lib/js/socket.io.js"></script>\n</head>',
                );
            },
        },
    };
}

export default defineConfig({
    plugins: [react(), adminSocketIo()],
    // the admin serves the tab from `adapter/recorder/tab.html`: every URL must be relative
    base: './',
    server: {
        port: 3000,
        proxy: {
            // `npm start`: socket.io and the admin files of a local admin on port 8081
            '/lib': 'http://localhost:8081',
        },
    },
    build: {
        target: 'chrome100',
        outDir: 'build',
        emptyOutDir: true,
        assetsDir: 'assets',
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
            input: 'tab.html',
        },
    },
});
