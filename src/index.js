const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connectToWhatsApp } = require('./whatsapp');

if (process.env.PORT) {
    const { createServer } = require('node:http');
    createServer((req, res) => {
        const isHealthCheck = req.url === '/health';
        res.writeHead(isHealthCheck ? 200 : 404, { 'Content-Type': 'text/plain' });
        res.end(isHealthCheck ? 'OK' : 'Not found');
    }).listen(Number(process.env.PORT), '0.0.0.0');
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
connectToWhatsApp().catch(err => {
    console.error('Erro inesperado na conexão:', err);
    process.exit(1);
});
