const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const webpmux = require('node-webpmux');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Adiciona metadados EXIF ao WebP para que o WhatsApp o reconheça
 * como figurinha oficial de pacote (permitindo salvar em favoritos e animar).
 */
async function addExif(webpBuffer, packName = 'Bot Figurinhas', authorName = 'Bot') {
    try {
        const img = new webpmux.Image();
        await img.load(webpBuffer);

        const json = {
            'sticker-pack-id': 'com.bot.stickers',
            'sticker-pack-name': packName,
            'sticker-pack-publisher': authorName,
            'emojis': ['🤖']
        };

        const exifAttr = Buffer.from([
            0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
            0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
        ]);

        const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
        const exif = Buffer.concat([exifAttr, jsonBuffer]);
        exif.writeUIntLE(jsonBuffer.length, 14, 4);

        img.exif = exif;
        return await img.save(null);
    } catch (err) {
        console.error('Erro ao adicionar EXIF na figurinha:', err);
        return webpBuffer; // Se falhar o EXIF, retorna o webp original
    }
}

/**
 * Converte imagens estáticas (JPG, PNG, WebP estático) para figurinha 1:1 quadrada (512x512).
 */
async function convertImageToSticker(imageBuffer) {
    const webpBuffer = await sharp(imageBuffer)
        .resize(512, 512, {
            fit: 'cover', // Preenche 100% da área 1:1 (512x512) sem bordas vazias
            position: 'center'
        })
        .webp({ quality: 80 })
        .toBuffer();

    return await addExif(webpBuffer);
}

/**
 * Converte vídeos (MP4, WebM, etc.) ou GIFs para figurinha animada 1:1 quadrada (512x512).
 */
async function convertVideoToAnimatedSticker(mediaBuffer) {
    const randomId = crypto.randomBytes(4).toString('hex');
    const tempInput = path.join(__dirname, `../temp_in_${randomId}.bin`);
    const tempOutput = path.join(__dirname, `../temp_out_${randomId}.webp`);

    fs.writeFileSync(tempInput, mediaBuffer);

    return new Promise((resolve, reject) => {
        ffmpeg(tempInput)
            .outputOptions([
                '-vcodec', 'libwebp',
                '-filter:v', 'crop=min(iw\\,ih):min(iw\\,ih),scale=512:512,fps=12', // Recorte 1:1 centralizado e redimensionamento 512x512
                '-lossless', '0',
                '-compression_level', '4',
                '-q:v', '35',
                '-loop', '0',
                '-an',
                '-vsync', '0',
                '-t', '6' // Máximo de 6 segundos para manter o tamanho dentro do limite do WhatsApp (< 1MB)
            ])
            .toFormat('webp')
            .save(tempOutput)
            .on('end', async () => {
                try {
                    const rawWebp = fs.readFileSync(tempOutput);
                    const finalSticker = await addExif(rawWebp);
                    resolve(finalSticker);
                } catch (e) {
                    reject(e);
                } finally {
                    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                }
            })
            .on('error', (err) => {
                if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                reject(err);
            });
    });
}

/**
 * Converte qualquer buffer (imagem, gif ou vídeo) para figurinha (estática ou animada).
 *
 * @param {Buffer} mediaBuffer - O buffer da mídia recebida.
 * @param {boolean} [isAnimated=false] - Força animação se conhecido.
 * @returns {Promise<Buffer>} - O buffer WebP final com EXIF.
 */
async function convertToSticker(mediaBuffer, isAnimated = false) {
    try {
        // Detecta se é GIF através dos bytes mágicos do cabeçalho
        const isGif = mediaBuffer.length > 3 && mediaBuffer.subarray(0, 3).toString() === 'GIF';
        
        if (isAnimated || isGif) {
            return await convertVideoToAnimatedSticker(mediaBuffer);
        } else {
            return await convertImageToSticker(mediaBuffer);
        }
    } catch (error) {
        console.error('Erro na conversão para figurinha:', error);
        throw new Error('Falha ao processar figurinha.');
    }
}

module.exports = {
    convertToSticker
};
