/**
 * Exportação opcional para .mcpack (pacote de skins do Minecraft Bedrock).
 *
 * Estrutura gerada (arquivos na RAIZ do zip, como exige o formato):
 *   manifest.json          -> format_version 1, módulo do tipo "skin_pack"
 *   skins.json             -> lista de skins, geometria classic/slim e textura
 *   <textura>.png          -> o PNG 128 × 128 original (sem redução)
 *   texts/en_US.lang       -> nomes exibidos no jogo
 *   texts/pt_BR.lang
 *   texts/languages.json
 *
 * Observação: 128 × 128 é um dos tamanhos de textura de skin aceitos pelo Bedrock
 * (64×32, 64×64 e 128×128). A geometria padrão define UVs em espaço 64 × 64,
 * normalizadas pelo tamanho real da textura, por isso o layout HD é o layout 64 × 2.
 */
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const GEOMETRY = {
    classic: 'geometry.humanoid.custom',
    slim: 'geometry.humanoid.customSlim'
};

/** Remove caracteres que quebram arquivos .lang (quebras de linha, "=" e não-ASCII de controle). */
function langSafe(text) {
    return String(text || '').replace(/[\r\n=]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Skin';
}

/**
 * @param {object} p
 * @param {Buffer} p.png Textura 128 × 128.
 * @param {'classic'|'slim'} p.model
 * @param {string} p.name Nome exibido da skin.
 * @returns {{ buffer: Buffer, files: string[], serializeName: string }}
 */
function buildMcpack({ png, model = 'classic', name = 'Skin personalizada' }) {
    if (!GEOMETRY[model]) throw new Error(`Modelo inválido para .mcpack: ${model}`);
    const id = crypto.randomBytes(4).toString('hex');
    const serializeName = `SkinBot${id}`;
    const textureFile = 'skin.png';
    const displayName = langSafe(name);

    const manifest = {
        format_version: 1,
        header: {
            name: `Skin Bot - ${displayName}`,
            uuid: crypto.randomUUID(),
            version: [1, 0, 0]
        },
        modules: [{
            type: 'skin_pack',
            uuid: crypto.randomUUID(),
            version: [1, 0, 0]
        }]
    };
    const skins = {
        skins: [{
            localization_name: 'skin1',
            geometry: GEOMETRY[model],
            texture: textureFile,
            type: 'free'
        }],
        serialize_name: serializeName,
        localization_name: serializeName
    };
    const lang = `skinpack.${serializeName}=Skin Bot - ${displayName}\nskin.${serializeName}.skin1=${displayName}\n`;

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    zip.addFile('skins.json', Buffer.from(JSON.stringify(skins, null, 2), 'utf8'));
    zip.addFile(textureFile, png);
    zip.addFile('texts/en_US.lang', Buffer.from(lang, 'utf8'));
    zip.addFile('texts/pt_BR.lang', Buffer.from(lang, 'utf8'));
    zip.addFile('texts/languages.json', Buffer.from(JSON.stringify(['en_US', 'pt_BR']), 'utf8'));

    return {
        buffer: zip.toBuffer(),
        files: zip.getEntries().map(e => e.entryName),
        serializeName
    };
}

module.exports = { buildMcpack, GEOMETRY };
