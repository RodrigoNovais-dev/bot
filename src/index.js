const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connectToWhatsApp } = require('./whatsapp');
const { createCloudWebhook } = require('./cloudWebhook');
const cloudWebhook = process.env.WA_CLOUD_ENABLED === '1' ? createCloudWebhook(process.env) : null;

if (process.env.PORT || cloudWebhook) {
    const { createServer } = require('node:http');
    const { readFileSync } = require('node:fs');
    const privacyPolicy = readFileSync(path.join(__dirname, 'privacy.txt'));
    createServer((req, res) => {
        if ((req.method === 'GET' || req.method === 'HEAD') && req.url?.split('?')[0] === '/privacidade') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(req.method === 'HEAD' ? undefined : privacyPolicy);
            return;
        }
        if (cloudWebhook && req.url?.split('?')[0] === '/webhook/whatsapp') {
            cloudWebhook(req, res).catch(err => {
                console.error('Falha no webhook do WhatsApp:', err.message);
                if (!res.writableEnded) res.writeHead(500).end();
            });
            return;
        }
        const isHealthCheck = req.url === '/health';
        res.writeHead(isHealthCheck ? 200 : 404, { 'Content-Type': 'text/plain' });
        res.end(isHealthCheck ? 'OK' : 'Not found');
    }).listen(Number(process.env.PORT || 3000), '0.0.0.0');
}

// Suprime logs internos informativos da libsignal que poluem o terminal
const originalInfo = console.info;
console.info = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('Closing session:')) return;
    originalInfo(...args);
};

const originalWarn = console.warn;
console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('Closing open session in favor of incoming prekey bundle')) return;
    originalWarn(...args);
};

const originalError = console.error;
console.error = (...args) => {
    const firstArg = typeof args[0] === 'string' ? args[0] : '';
    if (firstArg.includes('Failed to decrypt message with any known session') || firstArg.includes('Session error:')) {
        return;
    }
    originalError(...args);
};

process.on('unhandledRejection', (reason) => {
    console.error('Aviso (Promise não tratada):', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
    console.error('Aviso (Exceção capturada):', err?.message || err);
});

console.log('Iniciando o Bot de Figurinhas...');
if (!cloudWebhook) {
    connectToWhatsApp().catch(err => {
        console.error('Erro inesperado na conexão:', err);
        process.exit(1);
    });
}
