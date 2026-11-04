/**
 * Validação técnica do PNG final antes do envio.
 *
 * Verifica: assinatura PNG, cabeçalho IHDR (128 × 128, 8 bits, RGBA), camada base
 * 100% opaca em todas as regiões UV, áreas fora do UV transparentes, segunda camada
 * sem semitransparência e variedade mínima de cores (evita texturas "vazias").
 */
const sharp = require('sharp');
const { getLayout, baseRegions, overlayRegions } = require('./uvLayout');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Lê o chunk IHDR diretamente dos bytes do arquivo. */
function readIHDR(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        bitDepth: buf[24],
        colorType: buf[25], // 6 = RGBA
        interlace: buf[28]
    };
}

/**
 * @param {Buffer} png
 * @param {object} opts
 * @param {'classic'|'slim'} opts.model
 * @param {number} [opts.size=128]
 * @returns {Promise<{ valid: boolean, errors: string[], warnings: string[], info: object }>}
 */
async function validateSkinPng(png, { model = 'classic', size = 128 } = {}) {
    const errors = [];
    const warnings = [];
    const ihdr = readIHDR(png);
    if (!ihdr) return { valid: false, errors: ['Arquivo não é um PNG válido.'], warnings, info: {} };

    if (ihdr.width !== size || ihdr.height !== size) errors.push(`Resolução ${ihdr.width}x${ihdr.height}; esperado ${size}x${size}.`);
    if (ihdr.bitDepth !== 8) errors.push(`Profundidade de bits ${ihdr.bitDepth}; esperado 8.`);
    if (ihdr.colorType !== 6) errors.push(`Tipo de cor ${ihdr.colorType}; esperado 6 (RGBA).`);
    if (png.length > 1024 * 1024) errors.push('Arquivo PNG maior que 1 MB.');
    if (errors.length) return { valid: false, errors, warnings, info: { ihdr } };

    let data;
    try {
        const out = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        if (out.info.channels !== 4) errors.push(`PNG decodificado com ${out.info.channels} canais; esperado 4.`);
        data = out.data;
    } catch (err) {
        return { valid: false, errors: [`Falha ao decodificar o PNG: ${err.message}`], warnings, info: { ihdr } };
    }
    if (errors.length) return { valid: false, errors, warnings, info: { ihdr } };

    const layout = getLayout(model, size);
    const covered = new Uint8Array(size * size);
    const baseColors = new Set();
    let transparentBase = 0;

    for (const { part, face, rect: [x, y, w, h] } of baseRegions(layout)) {
        const faceColors = new Set();
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
            const k = j * size + i;
            covered[k] = 1;
            const p = k * 4;
            if (data[p + 3] !== 255) transparentBase++;
            const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
            baseColors.add(key);
            faceColors.add(key);
        }
        if (part === 'head' && face === 'front' && faceColors.size < 2) {
            errors.push('O rosto (frente da cabeça) não tem detalhes (uma única cor).');
        }
    }
    if (transparentBase) errors.push(`${transparentBase} pixel(s) transparentes na camada base (deve ser 100% opaca).`);
    if (baseColors.size < 4) errors.push(`Textura com apenas ${baseColors.size} cor(es); conteúdo insuficiente.`);

    let semiOverlay = 0, opaqueOverlay = 0;
    for (const { rect: [x, y, w, h] } of overlayRegions(layout)) {
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
            const k = j * size + i;
            covered[k] = 1;
            const a = data[k * 4 + 3];
            if (a !== 0 && a !== 255) semiOverlay++;
            if (a === 255) opaqueOverlay++;
        }
    }
    if (semiOverlay) errors.push(`${semiOverlay} pixel(s) semitransparentes na segunda camada.`);

    let strayPixels = 0;
    for (let k = 0; k < size * size; k++) if (!covered[k] && data[k * 4 + 3] !== 0) strayPixels++;
    if (strayPixels) warnings.push(`${strayPixels} pixel(s) visíveis fora das regiões UV (ignorados pelo jogo).`);

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        info: { ihdr, colors: baseColors.size, overlayOpaquePixels: opaqueOverlay, bytes: png.length }
    };
}

module.exports = { validateSkinPng, readIHDR };
