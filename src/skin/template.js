/**
 * Molde (template) enviado à IA de imagens.
 *
 * Em vez de pedir uma imagem livre e redimensioná-la (o que nunca gera um UV
 * correto), o bot desenha um "manequim" em blocos com as proporções exatas de
 * uma skin (vista frontal + vista traseira) sobre fundo magenta e pede à IA que
 * pinte o personagem DENTRO desse molde. Como sabemos a posição exata de cada
 * parte, depois conseguimos recortar cabeça/corpo/braços/pernas e transferi-los
 * para as regiões UV corretas.
 */
const sharp = require('sharp');
const { figureLayout } = require('./uvLayout');

const CANVAS_W = 1536;
const CANVAS_H = 1024;
const UNIT = 28; // pixels do molde por unidade do layout 64 (2 pixels da textura 128)
const BACKGROUND = [255, 0, 255];

const PART_COLORS = {
    head: [206, 206, 206],
    body: [184, 184, 184],
    rightArm: [168, 168, 168],
    leftArm: [168, 168, 168],
    rightLeg: [150, 150, 150],
    leftLeg: [150, 150, 150]
};

/** Calcula a geometria (em pixels) das duas vistas dentro do molde. */
function templateGeometry(model = 'classic') {
    const fig = figureLayout(model);
    const figW = fig.width * UNIT;
    const figH = fig.height * UNIT;
    const halfW = CANVAS_W / 2;
    const y0 = Math.round((CANVAS_H - figH) / 2);
    const build = (views, offsetX) => {
        const x0 = Math.round(offsetX + (halfW - figW) / 2);
        const parts = {};
        for (const [name, [ux, uy, uw, uh]] of Object.entries(views)) {
            parts[name] = [x0 + ux * UNIT, y0 + uy * UNIT, uw * UNIT, uh * UNIT];
        }
        return { x0, y0, w: figW, h: figH, parts };
    };
    return {
        model: fig.model,
        width: CANVAS_W,
        height: CANVAS_H,
        unit: UNIT,
        background: BACKGROUND,
        front: build(fig.front, 0),
        back: build(fig.back, halfW)
    };
}

function fillRect(buf, width, x, y, w, h, rgba) {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            const i = (yy * width + xx) * 4;
            buf[i] = rgba[0]; buf[i + 1] = rgba[1]; buf[i + 2] = rgba[2]; buf[i + 3] = rgba[3];
        }
    }
}

function strokeRect(buf, width, x, y, w, h, t, rgba) {
    fillRect(buf, width, x, y, w, t, rgba);
    fillRect(buf, width, x, y + h - t, w, t, rgba);
    fillRect(buf, width, x, y, t, h, rgba);
    fillRect(buf, width, x + w - t, y, t, h, rgba);
}

/**
 * Gera o PNG do molde e a máscara de edição.
 * @returns {Promise<{ template: Buffer, mask: Buffer, geometry: object }>}
 */
async function buildTemplate(model = 'classic') {
    const geo = templateGeometry(model);
    const { width, height } = geo;
    const img = Buffer.alloc(width * height * 4);
    const mask = Buffer.alloc(width * height * 4);
    fillRect(img, width, 0, 0, width, height, [...BACKGROUND, 255]);
    // Máscara: opaco = manter; transparente (alpha 0) = área que a IA deve pintar.
    fillRect(mask, width, 0, 0, width, height, [0, 0, 0, 255]);

    const cell = UNIT / 2; // 1 pixel da textura 128 × 128
    for (const view of [geo.front, geo.back]) {
        for (const [name, [x, y, w, h]] of Object.entries(view.parts)) {
            const c = PART_COLORS[name];
            fillRect(img, width, x, y, w, h, [...c, 255]);
            // Grade sutil na resolução final da textura (ajuda a IA a criar "pixels" alinhados).
            const grid = [c[0] - 14, c[1] - 14, c[2] - 14, 255];
            for (let gx = x + cell; gx < x + w; gx += cell) fillRect(img, width, gx, y, 1, h, grid);
            for (let gy = y + cell; gy < y + h; gy += cell) fillRect(img, width, x, gy, w, 1, grid);
            strokeRect(img, width, x, y, w, h, 2, [80, 80, 80, 255]);
            fillRect(mask, width, x, y, w, h, [0, 0, 0, 0]);
        }
    }
    // Marcação dos olhos apenas na vista frontal, para a IA saber qual lado é a frente.
    const [hx, hy] = geo.front.parts.head;
    fillRect(img, width, hx + 1 * UNIT, hy + 4 * UNIT, 2 * UNIT, UNIT, [96, 96, 96, 255]);
    fillRect(img, width, hx + 5 * UNIT, hy + 4 * UNIT, 2 * UNIT, UNIT, [96, 96, 96, 255]);

    const raw = { raw: { width, height, channels: 4 } };
    const [template, maskPng] = await Promise.all([
        sharp(img, raw).png().toBuffer(),
        sharp(mask, raw).png().toBuffer()
    ]);
    return { template, mask: maskPng, geometry: geo };
}

module.exports = { buildTemplate, templateGeometry, CANVAS_W, CANVAS_H, UNIT, BACKGROUND };
