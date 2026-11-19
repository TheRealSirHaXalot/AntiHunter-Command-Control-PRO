import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
    plugins: [react()],
    server: {
        port: 5173,
        allowedHosts: (loadEnv(mode, process.cwd(), '').AHCC_ALLOWED_HOSTS ?? '')
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean),
        proxy: {
            '/api': 'http://localhost:3000',
            '/healthz': 'http://localhost:3000',
            '/readyz': 'http://localhost:3000',
            '/metrics': 'http://localhost:3000',
            '/media': 'http://localhost:3000',
            '/socket.io': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: true,
            },
            '/ws': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: true,
            },
        },
    },
}));
//# sourceMappingURL=vite.config.js.map