/**
 * Construção da textura UV 128 × 128 a partir da imagem conceitual.
 *
 * Etapas:
 *  1. Decodifica a imagem conceitual e detecta a cor de fundo (magenta do molde).
 *  2. Alinha cada vista (frente/costas) procurando a caixa delimitadora do personagem.
 *  3. Cria uma paleta limitada (k-means) com as cores do personagem → pixel art nítida.
 *  4. Para cada pixel de cada face visível (frente/costas), faz "voto da maioria" no centro
 *     da célula correspondente da imagem conceitual (evita bordas borradas e a grade do molde).
 *  5. Gera as faces laterais, superior e inferior por extrusão das bordas da frente e das costas.
 *  6. Escreve tudo nas regiões UV corretas da camada base; a segunda camada fica transparente.
 */
const sharp = require('sharp');
const { getLayout, figureLayout } = require('./uvLayout');
const { templateGeometry } = require('./template');
const { SkinError } = require('./errors');

const BG_DISTANCE = 72;

// ---------------------------------------------------------------- utilitários de cor

function hexToRgb(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function dist2(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    // Pesos aproximados da percepção humana (verde > vermelho > azul).
    return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

function nearestIndex(palette, r, g, b) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const d = dist2(r, g, b, p[0], p[1], p[2]);
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/** Gerador pseudoaleatório determinístico (resultados reprodutíveis nos testes). */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** k-means++ simples em RGB. `samples` = array plano [r,g,b,r,g,b,...]. */
function kmeansPalette(samples, k, iterations = 12, seed = 1234) {
    const n = Math.floor(samples.length / 3);
    if (n === 0) return [[128, 128, 128]];
    k = Math.max(1, Math.min(k, n));
    const rand = mulberry32(seed);
    const centers = [];
    const first = Math.floor(rand() * n) * 3;
    centers.push([samples[first], samples[first + 1], samples[first + 2]]);
    const dists = new Float64Array(n).fill(Infinity);
    while (centers.length < k) {
        const c = centers[centers.length - 1];
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const d = dist2(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2], c[0], c[1], c[2]);
            if (d < dists[i]) dists[i] = d;
            sum += dists[i];
        }
        if (sum === 0) break;
        let r = rand() * sum, idx = 0;
        for (; idx < n - 1; idx++) { r -= dists[idx]; if (r <= 0) break; }
        centers.push([samples[idx * 3], samples[idx * 3 + 1], samples[idx * 3 + 2]]);
    }
    const assign = new Int32Array(n);
    for (let it = 0; it < iterations; it++) {
        const acc = centers.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            const a = nearestIndex(centers, samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
            assign[i] = a;
            const s = acc[a];
            s[0] += samples[i * 3]; s[1] += samples[i * 3 + 1]; s[2] += samples[i * 3 + 2]; s[3]++;
        }
        let moved = false;
        for (let c = 0; c < centers.length; c++) {
            const s = acc[c];
            if (!s[3]) continue;
            const nc = [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])];
            if (nc[0] !== centers[c][0] || nc[1] !== centers[c][1] || nc[2] !== centers[c][2]) moved = true;
            centers[c] = nc;
        }
        if (!moved) break;
    }
    // Remove cores praticamente duplicadas.
    const out = [];
    for (const c of centers) {
        if (!out.some(o => dist2(o[0], o[1], o[2], c[0], c[1], c[2]) < 9 * 6)) out.push(c);
    }
    return out;
}

// ---------------------------------------------------------------- imagem conceitual

class RgbImage {
    constructor(width, height, data) { this.width = width; this.height = height; this.data = data; }
    px(x, y) {
        const i = (y * this.width + x) * 3;
        return [this.data[i], this.data[i + 1], this.data[i + 2]];
    }
}

async function decodeConcept(buffer, width, height) {
    let img;
    try {
        img = sharp(buffer, { limitInputPixels: 40_000_000 });
        const meta = await img.metadata();
        if (!meta.width || !meta.height) throw new Error('sem dimensões');
        if (meta.width !== width || meta.height !== height) img = img.resize(width, height, { fit: 'fill', kernel: 'nearest' });
        const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
        return new RgbImage(info.width, info.height, data);
    } catch (err) {
        throw new SkinError('UV_FAILED', `Imagem conceitual inválida: ${err.message}`, { cause: err });
    }
}

/** Cor de fundo = mediana de amostras dos quatro cantos. */
function detectBackground(img) {
    const samples = [];
    const s = 24;
    const corners = [[0, 0], [img.width - s, 0], [0, img.height - s], [img.width - s, img.height - s]];
    for (const [cx, cy] of corners) {
        for (let y = cy; y < cy + s; y += 4) for (let x = cx; x < cx + s; x += 4) samples.push(img.px(x, y));
    }
    const med = (i) => samples.map(p => p[i]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    return [med(0), med(1), med(2)];
}

function makeBgTest(bg) {
    const limit = BG_DISTANCE * BG_DISTANCE * 3;
    return (r, g, b) => {
        const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
        return dr * dr + dg * dg + db * db < limit;
    };
}

/**
 * Encontra a caixa do personagem em uma metade da imagem e devolve uma função que
 * converte retângulos do molde para coordenadas reais da imagem gerada.
 */
function alignView(img, view, halfX0, halfX1, isBg) {
    const colCount = new Int32Array(img.width);
    const rowCount = new Int32Array(img.height);
    for (let y = 0; y < img.height; y += 2) {
        for (let x = halfX0; x < halfX1; x += 2) {
            const [r, g, b] = img.px(x, y);
            if (!isBg(r, g, b)) { colCount[x]++; rowCount[y]++; }
        }
    }
    const colMin = Math.max(3, Math.round(img.height * 0.02 / 2));
    const rowMin = Math.max(3, Math.round((halfX1 - halfX0) * 0.02 / 2));
    let x0 = -1, x1 = -1, y0 = -1, y1 = -1;
    for (let x = halfX0; x < halfX1; x++) if (colCount[x] >= colMin) { if (x0 < 0) x0 = x; x1 = x; }
    for (let y = 0; y < img.height; y++) if (rowCount[y] >= rowMin) { if (y0 < 0) y0 = y; y1 = y; }

    const identity = { aligned: false, map: (r) => r };
    if (x0 < 0 || y0 < 0) return identity;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const sx = w / view.w, sy = h / view.h;
    const plausible = sx > 0.8 && sx < 1.2 && sy > 0.8 && sy < 1.2 && Math.abs(sx - sy) < 0.15;
    if (!plausible) return identity;
    return {
        aligned: true,
        map: ([rx, ry, rw, rh]) => [x0 + (rx - view.x0) * sx, y0 + (ry - view.y0) * sy, rw * sx, rh * sy]
    };
}

/** Coleta amostras de cor (sem fundo) dentro das partes das duas vistas. */
function collectSamples(img, rects, isBg) {
    const out = [];
    for (const [x, y, w, h] of rects) {
        const step = 3;
        for (let yy = Math.floor(y); yy < y + h; yy += step) {
            for (let xx = Math.floor(x); xx < x + w; xx += step) {
                if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
                const [r, g, b] = img.px(xx, yy);
                if (!isBg(r, g, b)) out.push(r, g, b);
            }
        }
    }
    return out;
}

/**
 * Amostra uma face: cada pixel da textura recebe a cor (índice da paleta) mais votada
 * no miolo da célula correspondente. Retorna Int16Array com -1 onde predominou o fundo.
 */
function sampleFace(img, rect, tw, th, palette, isBg) {
    const [x, y, w, h] = rect;
    const out = new Int16Array(tw * th);
    const cw = w / tw, ch = h / th;
    const inset = 0.2;
    const counts = new Int32Array(palette.length + 1);
    for (let j = 0; j < th; j++) {
        for (let i = 0; i < tw; i++) {
            counts.fill(0);
            const xs = Math.floor(x + (i + inset) * cw), xe = Math.ceil(x + (i + 1 - inset) * cw);
            const ys = Math.floor(y + (j + inset) * ch), ye = Math.ceil(y + (j + 1 - inset) * ch);
            for (let yy = ys; yy < ye; yy++) {
                if (yy < 0 || yy >= img.height) continue;
                for (let xx = xs; xx < xe; xx++) {
                    if (xx < 0 || xx >= img.width) continue;
                    const [r, g, b] = img.px(xx, yy);
                    if (isBg(r, g, b)) counts[palette.length]++;
                    else counts[nearestIndex(palette, r, g, b)]++;
                }
            }
            let best = palette.length, bestC = -1;
            for (let c = 0; c <= palette.length; c++) if (counts[c] > bestC) { bestC = counts[c]; best = c; }
            out[j * tw + i] = best === palette.length ? -1 : best;
        }
    }
    return out;
}

// ---------------------------------------------------------------- montagem da textura

/** Imagem RGBA simples usada para as faces. */
function makeFace(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }
function getPx(face, x, y) { const i = (y * face.w + x) * 4; return face.data.subarray(i, i + 4); }
function setPx(face, x, y, rgba) {
    const i = (y * face.w + x) * 4;
    face.data[i] = rgba[0]; face.data[i + 1] = rgba[1]; face.data[i + 2] = rgba[2]; face.data[i + 3] = rgba[3] ?? 255;
}

/** Gera as 6 faces de uma caixa a partir da frente e das costas (extrusão das bordas). */
function synthesizeBox(front, back, d) {
    const { w, h } = front;
    const half = d / 2;
    const right = makeFace(d, h), left = makeFace(d, h), top = makeFace(w, d), bottom = makeFace(w, d);
    for (let y = 0; y < h; y++) {
        for (let c = 0; c < d; c++) {
            // Lado direito do personagem: borda de trás à esquerda, borda da frente à direita.
            setPx(right, c, y, c < half ? getPx(back, w - 1, y) : getPx(front, 0, y));
            // Lado esquerdo: borda da frente à esquerda, borda de trás à direita.
            setPx(left, c, y, c < half ? getPx(front, w - 1, y) : getPx(back, 0, y));
        }
    }
    for (let r = 0; r < d; r++) {
        for (let x = 0; x < w; x++) {
            setPx(top, x, r, r < half ? getPx(back, w - 1 - x, 0) : getPx(front, x, 0));
            setPx(bottom, x, r, r < half ? getPx(front, x, h - 1) : getPx(back, w - 1 - x, h - 1));
        }
    }
    return { front, back, right, left, top, bottom };
}

function blit(texture, size, face, [x, y]) {
    for (let j = 0; j < face.h; j++) {
        for (let i = 0; i < face.w; i++) {
            const s = (j * face.w + i) * 4, t = ((y + j) * size + (x + i)) * 4;
            texture[t] = face.data[s]; texture[t + 1] = face.data[s + 1];
            texture[t + 2] = face.data[s + 2]; texture[t + 3] = face.data[s + 3];
        }
    }
}

/** Monta a textura final (RGBA) a partir das faces frente/costas de cada parte. */
function assembleTexture(layout, frontFaces, backFaces) {
    const size = layout.size;
    const texture = new Uint8ClampedArray(size * size * 4); // tudo transparente
    for (const [name, part] of Object.entries(layout.parts)) {
        const faces = synthesizeBox(frontFaces[name], backFaces[name], part.dims.d);
        for (const faceName of ['top', 'bottom', 'right', 'front', 'left', 'back']) {
            blit(texture, size, faces[faceName], part.base[faceName]);
        }
    }
    return texture;
}

async function encodePng(texture, size) {
    return sharp(Buffer.from(texture.buffer, texture.byteOffset, texture.byteLength), {
        raw: { width: size, height: size, channels: 4 }
    }).png({ compressionLevel: 9, palette: false }).toBuffer();
}

/**
 * Constrói a textura a partir da imagem conceitual gerada pela IA.
 * @returns {Promise<{ png: Buffer, stats: object }>}
 */
async function buildTextureFromConcept(conceptBuffer, { model = 'classic', size = 128, paletteColors = 32, specPalette } = {}) {
    const layout = getLayout(model, size);
    const geo = templateGeometry(model);
    const img = await decodeConcept(conceptBuffer, geo.width, geo.height);
    const bg = detectBackground(img);
    const isBg = makeBgTest(bg);

    const half = geo.width / 2;
    const frontAlign = alignView(img, geo.front, 0, half, isBg);
    const backAlign = alignView(img, geo.back, half, geo.width, isBg);

    const rects = [
        ...Object.values(geo.front.parts).map(frontAlign.map),
        ...Object.values(geo.back.parts).map(backAlign.map)
    ];
    const samples = collectSamples(img, rects, isBg);
    if (samples.length < 300) {
        throw new SkinError('UV_FAILED', 'A imagem conceitual não contém o personagem (quase tudo é fundo).');
    }
    let palette = kmeansPalette(samples, paletteColors);
    // Garante que as cores principais definidas pela análise possam aparecer (olhos etc.).
    if (specPalette) {
        for (const hex of Object.values(specPalette)) {
            const c = hexToRgb(hex);
            const present = samples.length && (() => {
                for (let i = 0; i < samples.length; i += 3 * 7) {
                    if (dist2(samples[i], samples[i + 1], samples[i + 2], c[0], c[1], c[2]) < 9 * 40) return true;
                }
                return false;
            })();
            if (present && !palette.some(p => dist2(p[0], p[1], p[2], c[0], c[1], c[2]) < 9 * 40)) palette.push(c);
        }
    }

    let bgCells = 0, totalCells = 0;
    const toFaces = (view, align) => {
        const faces = {};
        for (const [name, rect] of Object.entries(view.parts)) {
            const { w, h } = layout.parts[name].dims;
            const idx = sampleFace(img, align.map(rect), w, h, palette, isBg);
            // Células onde o fundo "vazou": usa a cor dominante da própria parte.
            const freq = new Int32Array(palette.length);
            for (const v of idx) if (v >= 0) freq[v]++;
            let dominant = 0;
            for (let c = 1; c < freq.length; c++) if (freq[c] > freq[dominant]) dominant = c;
            const face = makeFace(w, h);
            for (let k = 0; k < idx.length; k++) {
                totalCells++;
                let v = idx[k];
                if (v < 0) { bgCells++; v = dominant; }
                const c = palette[v];
                setPx(face, k % w, Math.floor(k / w), [c[0], c[1], c[2], 255]);
            }
            faces[name] = face;
        }
        return faces;
    };
    const frontFaces = toFaces(geo.front, frontAlign);
    const backFaces = toFaces(geo.back, backAlign);

    const texture = assembleTexture(layout, frontFaces, backFaces);
    const png = await encodePng(texture, size);
    return {
        png,
        texture,
        stats: {
            source: 'concept',
            background: bg,
            paletteSize: palette.length,
            backgroundLeakRatio: totalCells ? bgCells / totalCells : 1,
            frontAligned: frontAlign.aligned,
            backAligned: backAlign.aligned
        }
    };
}

// ---------------------------------------------------------------- modo de contingência

function shade(rgb, f) { return rgb.map(v => Math.max(0, Math.min(255, Math.round(v * f)))); }

/**
 * Constrói uma textura HD 128 × 128 detalhada em pixel art (com sombreamento
 * por pixel e segunda camada 3D de relevo) a partir da especificação do personagem.
 * Usada automaticamente quando a conta da OpenAI está sem créditos ou indisponível.
 */
async function buildProceduralTexture(spec, { model = 'classic', size = 128 } = {}) {
    const layout = getLayout(model, size);
    const s = layout.scale; // 2 para 128x128
    const P = Object.fromEntries(Object.entries(spec.paleta).map(([k, v]) => [k, hexToRgb(v)]));
    const white = [245, 245, 250];
    const hairColor = spec.cabelo_estilo === 'careca' ? P.pele
        : spec.cabelo_estilo === 'capuz' ? P.roupa_superior
            : spec.cabelo_estilo === 'capacete' ? P.destaque : P.cabelo;
    const rand = mulberry32(42);

    const hdFace = (w, h, painter) => {
        const face = makeFace(w, h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const base = painter(x, y, w, h);
                const borderDark = (x === 0 || x === w - 1 || y === 0 || y === h - 1) ? 0.92 : 1.0;
                const noise = (0.96 + rand() * 0.08) * borderDark;
                setPx(face, x, y, [...shade(base, noise), 255]);
            }
        }
        return face;
    };

    const hooded = spec.cabelo_estilo === 'capuz' || spec.cabelo_estilo === 'capacete';

    // Cabeça frontal 16x16 (em 128x128)
    const headFront = (x, y, w, h) => {
        const ux = x / s, uy = y / s;
        if (uy < 2.0) return y === 2 * s - 1 ? P.destaque : hairColor;
        if (hooded && (ux < 1.0 || ux >= 7.0)) return hairColor;
        if (spec.cabelo_estilo === 'longo' && (ux < 1.0 || ux >= 7.0)) return hairColor;
        if (uy < 3.0 && spec.cabelo_estilo !== 'careca' && (ux < 1.5 || ux >= 6.5)) return hairColor;
        // Sobrancelhas
        if (y === 3 * s + 1 && ((ux >= 1 && ux < 3.5) || (ux >= 4.5 && ux < 7))) {
            return shade(hairColor, 0.7);
        }
        // Olhos HD (esclera + íris + brilho)
        if (uy >= 4.0 && uy < 5.0) {
            if ((ux >= 1.0 && ux < 2.0) || (ux >= 6.0 && ux < 7.0)) return white;
            if ((ux >= 2.0 && ux < 3.5) || (ux >= 4.5 && ux < 6.0)) {
                return (y % 2 === 0 && (x === Math.floor(2.5 * s) || x === Math.floor(5.0 * s)))
                    ? shade(P.olhos, 1.35)
                    : P.olhos;
            }
        }
        // Máscara facial (ninja / assassino / capacete)
        if (spec.mascara_facial && uy >= 5.0) {
            if (y === Math.floor(5.0 * s)) return P.destaque;
            return shade(P.roupa_superior, (x + y) % 2 === 0 ? 0.82 : 0.74);
        }
        // Boca / sombra do nariz
        if (uy >= 6.0 && uy < 6.8 && ux >= 3.0 && ux < 5.0) return shade(P.pele, 0.72);
        return P.pele;
    };

    const headBack = (x, y) => {
        const uy = y / s;
        if (spec.cabelo_estilo === 'curto' && uy >= 6.5) return P.pele;
        if (hooded && Math.abs(x - 4 * s) <= 1) return shade(hairColor, 0.82);
        return hairColor;
    };

    // Tronco 16x24
    const torso = (back) => (x, y, w, h) => {
        const ux = x / s, uy = y / s;
        // Cinto e fivela
        if (uy >= 9.0 && uy < 10.5) {
            if (!back && ux >= 3.0 && ux < 5.0) return P.destaque_secundario;
            return P.destaque;
        }
        // Gola / pescoço
        if (!back && uy < 1.0 && ux >= 3.0 && ux < 5.0) return spec.mascara_facial ? shade(P.roupa_superior, 0.7) : P.pele;
        // Detalhes peitorais / faixas roxas ou da cor de destaque
        if (!back && ((ux >= 1.5 && ux < 2.5) || (ux >= 5.5 && ux < 6.5)) && uy >= 1.0 && uy < 9.0) {
            return P.destaque;
        }
        if (!back && uy >= 2.5 && uy < 4.5 && ux >= 3.0 && ux < 5.0) {
            return P.destaque;
        }
        if (back && ux >= 3.0 && ux < 5.0 && uy >= 2.0 && uy < 8.0) {
            return shade(P.destaque, 0.9);
        }
        const edgeShade = (ux < 1.0 || ux >= 7.0) ? 0.86 : 1.0;
        return shade(P.roupa_superior, edgeShade);
    };

    // Braços
    const arm = (x, y, w, h) => {
        const uy = y / s;
        if (uy >= 10.0) return P.pele; // mãos
        if (uy >= 8.5 && uy < 10.0) return P.destaque; // braceletes / punhos
        if (uy < 1.5) return shade(P.destaque, 0.9); // ombreira
        return P.roupa_superior;
    };

    // Pernas
    const leg = (x, y, w, h) => {
        const uy = y / s;
        if (uy >= 11.0) return shade(P.calcados, 0.65); // sola
        if (uy >= 9.0) return y === Math.floor(9.0 * s) ? P.destaque : P.calcados; // botas
        if (uy >= 5.0 && uy < 6.0) return shade(P.destaque, 0.85); // joelheira / faixa
        return P.roupa_inferior;
    };

    const frontFaces = {}, backFaces = {};
    for (const [name, part] of Object.entries(layout.parts)) {
        const { w, h } = part.dims;
        const painterF = name === 'head' ? headFront : name === 'body' ? torso(false) : name.includes('Arm') ? arm : leg;
        const painterB = name === 'head' ? headBack : name === 'body' ? torso(true) : name.includes('Arm') ? arm : leg;
        frontFaces[name] = hdFace(w, h, painterF);
        backFaces[name] = hdFace(w, h, painterB);
    }
    const texture = assembleTexture(layout, frontFaces, backFaces);

    // Adiciona detalhes na segunda camada 3D (overlay) com opacidade 100% (255)
    const paintOverlayRect = ([rx, ry, rw, rh], predFn, colorFn) => {
        for (let j = 0; j < rh; j++) {
            for (let i = 0; i < rw; i++) {
                if (!predFn(i, j, rw, rh)) continue;
                const c = colorFn(i, j);
                const t = ((ry + j) * size + (rx + i)) * 4;
                texture[t] = c[0]; texture[t + 1] = c[1]; texture[t + 2] = c[2]; texture[t + 3] = 255;
            }
        }
    };

    // Borda do capuz/cabelo na camada externa da cabeça (head.overlay.front)
    if (spec.cabelo_estilo !== 'careca') {
        paintOverlayRect(
            layout.parts.head.overlay.front,
            (i, j, rw, rh) => j < 2 * s || (hooded && (i < s || i >= rw - s)),
            (i, j) => (j === 2 * s - 1 ? P.destaque : shade(hairColor, 1.05))
        );
    }
    // Cinto em relevo 3D no tronco (body.overlay.front)
    paintOverlayRect(
        layout.parts.body.overlay.front,
        (i, j) => j >= 9 * s && j < 10 * s,
        (i) => (i >= 3 * s && i < 5 * s ? P.destaque_secundario : P.destaque)
    );

    const png = await encodePng(texture, size);
    return { png, texture, stats: { source: 'procedural', backgroundLeakRatio: 0 } };
}

// ---------------------------------------------------------------- pré-visualização

/**
 * Renderiza uma pré-visualização 2D (frente e costas) a partir da textura final,
 * ampliada sem suavização, para o usuário conferir no WhatsApp.
 */
async function renderPreview(texturePng, model = 'classic', zoom = 6) {
    const { data, info } = await sharp(texturePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const size = info.width;
    const layout = getLayout(model, size);
    const fig = figureLayout(model);
    const s = layout.scale;
    const figW = fig.width * s, figH = fig.height * s, gap = 8 * s, margin = 6 * s;
    const W = margin * 2 + figW * 2 + gap, H = margin * 2 + figH;
    const out = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const checker = ((x >> 2) + (y >> 2)) % 2 ? 54 : 46;
        const i = (y * W + x) * 4; out[i] = checker; out[i + 1] = checker; out[i + 2] = checker + 8; out[i + 3] = 255;
    }
    const drawRegion = (src, dx, dy) => {
        const [sx, sy, sw, sh] = src;
        for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) {
            const si = ((sy + j) * size + (sx + i)) * 4;
            if (data[si + 3] === 0) continue;
            const a = data[si + 3] / 255;
            const di = ((dy + j) * W + (dx + i)) * 4;
            for (let c = 0; c < 3; c++) out[di + c] = Math.round(data[si + c] * a + out[di + c] * (1 - a));
        }
    };
    const views = [['front', fig.front, margin], ['back', fig.back, margin + figW + gap]];
    for (const [faceName, view, ox] of views) {
        for (const [name, [ux, uy]] of Object.entries(view)) {
            const part = layout.parts[name];
            drawRegion(part.base[faceName], ox + ux * s, margin + uy * s);
            drawRegion(part.overlay[faceName], ox + ux * s, margin + uy * s);
        }
    }
    return sharp(out, { raw: { width: W, height: H, channels: 4 } })
        .resize(W * zoom, H * zoom, { kernel: 'nearest' })
        .png()
        .toBuffer();
}

module.exports = {
    buildTextureFromConcept,
    buildProceduralTexture,
    renderPreview,
    // Exportados para testes
    kmeansPalette,
    synthesizeBox,
    detectBackground,
    hexToRgb
};
