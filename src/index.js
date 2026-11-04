const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { connectToWhatsApp } = require('./whatsapp');

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
