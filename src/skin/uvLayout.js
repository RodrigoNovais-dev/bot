/**
 * Mapeamento UV das skins de Minecraft (Bedrock/Java compartilham o mesmo layout).
 *
 * O layout de referência é o de 64 × 64. Skins HD de 128 × 128 usam exatamente
 * o mesmo layout multiplicado por 2 (cada "pixel" do layout 64 vira um bloco 2 × 2),
 * pois a geometria padrão (geometry.humanoid.custom / customSlim) define as UVs
 * em um espaço de 64 × 64 que é normalizado pelo tamanho real da textura.
 *
 * Convenção das faces (igual à do Minecraft):
 *   top    = topo da caixa         bottom = base da caixa
 *   right  = lado direito do PERSONAGEM (à esquerda de quem olha de frente)
 *   front  = frente                left   = lado esquerdo do personagem
 *   back   = costas (vista por trás, sem espelhamento)
 */

const MODELS = ['classic', 'slim'];

/** Dimensões das caixas (w = largura, h = altura, d = profundidade) e origem UV (u, v) no espaço 64. */
function partDefinitions(model) {
    const armW = model === 'slim' ? 3 : 4;
    return {
        head:     { w: 8,    h: 8,  d: 8, base: [0, 0],   overlay: [32, 0] },
        body:     { w: 8,    h: 12, d: 4, base: [16, 16], overlay: [16, 32] },
        rightArm: { w: armW, h: 12, d: 4, base: [40, 16], overlay: [40, 32] },
        leftArm:  { w: armW, h: 12, d: 4, base: [32, 48], overlay: [48, 48] },
        rightLeg: { w: 4,    h: 12, d: 4, base: [0, 16],  overlay: [0, 32] },
        leftLeg:  { w: 4,    h: 12, d: 4, base: [16, 48], overlay: [0, 48] }
    };
}

/** Retângulos [x, y, w, h] das 6 faces de uma caixa a partir da origem UV. */
function boxFaces(u, v, w, h, d) {
    return {
        top:    [u + d,         v,     w, d],
        bottom: [u + d + w,     v,     w, d],
        right:  [u,             v + d, d, h],
        front:  [u + d,         v + d, w, h],
        left:   [u + d + w,     v + d, d, h],
        back:   [u + d + w + d, v + d, w, h]
    };
}

function normalizeModel(model) {
    const m = String(model || 'classic').toLowerCase();
    if (!MODELS.includes(m)) throw new Error(`Modelo desconhecido: ${model}`);
    return m;
}

/**
 * Retorna o layout completo já escalado para o tamanho da textura.
 * @param {'classic'|'slim'} model
 * @param {number} size 64 ou 128
 */
function getLayout(model = 'classic', size = 128) {
    model = normalizeModel(model);
    if (size % 64 !== 0) throw new Error('O tamanho da textura deve ser múltiplo de 64.');
    const s = size / 64;
    const defs = partDefinitions(model);
    const parts = {};
    for (const [name, p] of Object.entries(defs)) {
        const scaleRect = (r) => r.map(n => n * s);
        const base = boxFaces(p.base[0], p.base[1], p.w, p.h, p.d);
        const overlay = boxFaces(p.overlay[0], p.overlay[1], p.w, p.h, p.d);
        parts[name] = {
            dims: { w: p.w * s, h: p.h * s, d: p.d * s },
            base: Object.fromEntries(Object.entries(base).map(([k, r]) => [k, scaleRect(r)])),
            overlay: Object.fromEntries(Object.entries(overlay).map(([k, r]) => [k, scaleRect(r)]))
        };
    }
    return { model, size, scale: s, parts };
}

/** Lista plana de retângulos da camada base (devem ser 100% opacos). */
function baseRegions(layout) {
    return Object.entries(layout.parts).flatMap(([part, p]) =>
        Object.entries(p.base).map(([face, rect]) => ({ part, face, rect })));
}

/** Lista plana de retângulos da camada externa (overlay/segunda camada). */
function overlayRegions(layout) {
    return Object.entries(layout.parts).flatMap(([part, p]) =>
        Object.entries(p.overlay).map(([face, rect]) => ({ part, face, rect })));
}

/**
 * Posição de cada parte na vista frontal e traseira do personagem, em "unidades"
 * do layout 64 (1 unidade = 1 pixel de uma skin 64 × 64).
 * Usado para montar o molde enviado à IA e para recortar a imagem conceitual.
 */
function figureLayout(model = 'classic') {
    model = normalizeModel(model);
    const a = model === 'slim' ? 3 : 4;
    const width = 8 + 2 * a;
    const height = 32;
    // Vista frontal: o braço DIREITO do personagem aparece à esquerda de quem olha.
    const front = {
        head:     [a,     0,  8, 8],
        body:     [a,     8,  8, 12],
        rightArm: [0,     8,  a, 12],
        leftArm:  [a + 8, 8,  a, 12],
        rightLeg: [a,     20, 4, 12],
        leftLeg:  [a + 4, 20, 4, 12]
    };
    // Vista traseira (olhando por trás): o braço ESQUERDO aparece à esquerda.
    const back = {
        head:     [a,     0,  8, 8],
        body:     [a,     8,  8, 12],
        leftArm:  [0,     8,  a, 12],
        rightArm: [a + 8, 8,  a, 12],
        leftLeg:  [a,     20, 4, 12],
        rightLeg: [a + 4, 20, 4, 12]
    };
    return { model, width, height, front, back };
}

module.exports = { MODELS, normalizeModel, getLayout, baseRegions, overlayRegions, figureLayout, boxFaces };
