/**
 * Geração do conceito visual com a IA de imagens da OpenAI (Image API - edits).
 *
 * A IA recebe o molde (manequim em blocos, vista frontal + traseira) e, se houver,
 * a imagem de referência do usuário. Ela pinta o personagem sobre o molde, o que
 * permite recortar cada parte do corpo com precisão em textureBuilder.js.
 */
const { toFile } = require('openai');
const config = require('../config');
const { SkinError } = require('./errors');
const { getOpenAIClient, withModelFallback, safetyIdentifier } = require('./openaiClient');

function buildConceptPrompt(spec, { model, hasReference }) {
    const armW = model === 'slim' ? 3 : 4;
    const p = spec.paleta;
    return [
        'Paint a Minecraft Bedrock skin concept sheet.',
        'Image 1 is a TEMPLATE: two blocky gray mannequins on a solid magenta (#FF00FF) background.',
        'The LEFT mannequin is the FRONT view (two dark marks show where the eyes go).',
        'The RIGHT mannequin is the BACK view seen from behind (back of the head, no face).',
        hasReference ? 'Image 2 is the character reference provided by the user: reproduce its colors, clothing, hair and accessories faithfully.' : '',
        '',
        'Repaint BOTH mannequins as the character described below, in clean retro pixel-art style:',
        `- Keep EXACTLY the same blocky silhouette, position, size and proportions of every block (head 8x8, torso 8x12, arms ${armW}x12, legs 4x12 units). Do not move, rotate, resize, add or remove parts.`,
        '- Flat orthographic view: no perspective, no 3D lighting, no drop shadows, no outlines around the figure, no text, no logos.',
        '- Cover every block completely, edge to edge, with crisp square pixels aligned to the faint grid (the face is a 16x16 pixel grid). Use solid flat colors with only subtle pixel shading, no blur, no gradients, no anti-aliasing.',
        '- Hair, hoods and hats must stay inside the head block. Capes, wings or weapons must be painted flat on the clothing instead of sticking out.',
        '- The face appears only on the front of the head, with the eyes on the marked row. The back view shows the back of the hair/hood and the back of the clothes.',
        '- Keep the background solid flat magenta #FF00FF and draw nothing outside the mannequins.',
        '',
        `Character: ${spec.resumo || spec.tema}`,
        `Front view: ${spec.descricao_frente_en}`,
        `Back view: ${spec.descricao_costas_en}`,
        `Color palette: skin ${p.pele}, hair ${p.cabelo}, eyes ${p.olhos}, top ${p.roupa_superior}, bottom ${p.roupa_inferior}, shoes ${p.calcados}, accent ${p.destaque}, secondary accent ${p.destaque_secundario}.`
    ].filter(line => line !== null).join('\n');
}

/** input_fidelity só é aceito por gpt-image-1 / gpt-image-1.5 (não pelo mini nem pelos 2.x). */
function supportsInputFidelity(model) {
    return /^gpt-image-1(\.5)?(-\d{4}-\d{2}-\d{2})?$/.test(model);
}

/**
 * @param {object} p
 * @param {object} p.spec Especificação retornada pelo analisador.
 * @param {{template: Buffer, mask: Buffer, geometry: object}} p.template
 * @param {Buffer} [p.referenceImage]
 * @param {'classic'|'slim'} p.model
 * @param {string} [p.userId]
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.client]
 * @returns {Promise<{ image: Buffer, imageModel: string }>}
 */
async function generateConcept({ spec, template, referenceImage, model, userId, signal, client }) {
    const openai = client || getOpenAIClient();
    const prompt = buildConceptPrompt(spec, { model, hasReference: Boolean(referenceImage) });
    const models = [config.skin.imageModel, ...config.skin.imageFallbackModels];

    return withModelFallback(models, async (m) => {
        const images = [await toFile(template.template, 'molde.png', { type: 'image/png' })];
        if (referenceImage) images.push(await toFile(referenceImage, 'referencia.png', { type: 'image/png' }));
        const params = {
            model: m,
            image: images,
            mask: await toFile(template.mask, 'mascara.png', { type: 'image/png' }),
            prompt,
            n: 1,
            size: `${template.geometry.width}x${template.geometry.height}`,
            quality: config.skin.imageQuality,
            output_format: 'png',
            safety_identifier: safetyIdentifier(userId)
        };
        if (supportsInputFidelity(m) && config.skin.imageInputFidelity) params.input_fidelity = config.skin.imageInputFidelity;

        const result = await openai.images.edit(params, { signal });
        const b64 = result?.data?.[0]?.b64_json;
        if (!b64) throw new SkinError('GENERATION_FAILED', 'A IA de imagens não retornou nenhuma imagem.');
        return { image: Buffer.from(b64, 'base64'), imageModel: m };
    });
}

module.exports = { generateConcept, buildConceptPrompt, supportsInputFidelity };
