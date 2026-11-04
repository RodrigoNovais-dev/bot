/**
 * Gerenciamento de arquivos temporários e nomes de arquivo seguros do !criarskin.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/** Converte um texto livre em um trecho seguro para nome de arquivo (sem acentos, ASCII). */
function safeSlug(text, maxLen = 32) {
    const slug = String(text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, maxLen)
        .replace(/_+$/g, '');
    return slug || 'skin';
}

/** Nome de arquivo final: skin_<tema>_<modelo>_128x128.<ext> */
function skinFileName(theme, model, ext, size = 128) {
    const safeExt = String(ext).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
    const safeModel = model === 'slim' ? 'slim' : 'classic';
    return `skin_${safeSlug(theme)}_${safeModel}_${size}x${size}.${safeExt}`;
}

/** Cria um diretório temporário exclusivo para uma geração. */
async function createJobDir(baseDir = config.skin.tempDir) {
    await fsp.mkdir(baseDir, { recursive: true });
    const dir = path.join(baseDir, `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(dir);
    return dir;
}

/** Grava um arquivo dentro do diretório do job, impedindo path traversal. */
async function writeJobFile(dir, fileName, data) {
    const target = path.resolve(dir, path.basename(fileName));
    if (path.dirname(target) !== path.resolve(dir)) throw new Error('Nome de arquivo inseguro.');
    await fsp.writeFile(target, data);
    return target;
}

async function removeDir(dir) {
    if (!dir) return;
    try {
        await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn('[criarskin] Não foi possível remover temporários:', err.message);
    }
}

/** Remove diretórios de jobs antigos (ex.: sobras de um encerramento abrupto do bot). */
async function cleanupStale(maxAgeMs = 30 * 60 * 1000, baseDir = config.skin.tempDir) {
    if (!fs.existsSync(baseDir)) return 0;
    let removed = 0;
    const now = Date.now();
    for (const entry of await fsp.readdir(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('job_')) continue;
        const full = path.join(baseDir, entry.name);
        try {
            const st = await fsp.stat(full);
            if (now - st.mtimeMs > maxAgeMs) { await removeDir(full); removed++; }
        } catch { /* ignora */ }
    }
    return removed;
}

module.exports = { safeSlug, skinFileName, createJobDir, writeJobFile, removeDir, cleanupStale };
