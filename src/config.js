const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const FALLBACK_ENV_PATH = path.resolve(__dirname, '..', '..', 'bot skin', '.env');
const dataPath = path.resolve(__dirname, '..', process.env.BOT_DATA_DIR || '.');

/**
 * Recarrega variáveis do arquivo .env em tempo de execução caso o usuário
 * tenha salvo o .env com o bot já aberto (sem precisar reiniciar).
 */
function reloadEnvIfNeeded() {
  for (const p of [ENV_PATH, FALLBACK_ENV_PATH]) {
    try {
      if (fs.existsSync(p)) {
        const parsed = dotenv.parse(fs.readFileSync(p));
        if (parsed.OPENAI_API_KEY && parsed.OPENAI_API_KEY !== 'sua_chave_aqui') {
          for (const [k, v] of Object.entries(parsed)) {
            if (!process.env[k] || process.env[k] === 'sua_chave_aqui') {
              process.env[k] = v;
            }
          }
          break;
        }
      }
    } catch {
      // ignora erro de leitura
    }
  }
}

/** Lê um inteiro do ambiente com valor padrão e limites seguros. */
function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Lê um booleano do ambiente ("true"/"1"/"sim"). */
function envBool(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(raw);
}

function envStr(name, fallback) {
  const raw = (process.env[name] || '').trim();
  return raw || fallback;
}

module.exports = {
  sessionPath: path.join(dataPath, 'auth_info_baileys'),
  remindersPath: path.join(dataPath, 'lembretes.json'),
  stickerOptions: {
    pack: 'Bot de Figurinhas',
    author: 'Criado pelo Bot'
  },

  /**
   * Configuração centralizada do comando !criarskin.
   * Getters são usados para que mudanças no .env (carregado em index.js)
   * e nos testes sejam sempre respeitadas.
   */
  skin: {
    // ---- Modelos da OpenAI (altere aqui ou no .env para atualizar no futuro) ----
    get openaiApiKey() {
      let key = (process.env.OPENAI_API_KEY || '').trim();
      if ((!key || key === 'sua_chave_aqui') && process.env.SKIN_DISABLE_ENV_AUTORELOAD !== '1') {
        reloadEnvIfNeeded();
        key = (process.env.OPENAI_API_KEY || '').trim();
      }
      return key;
    },
    /** Modelo multimodal usado para entender o texto e analisar imagens (Responses API). */
    get visionModel() { return envStr('OPENAI_VISION_MODEL', 'gpt-5.4-mini'); },
    /** Modelos alternativos tentados se o principal não estiver disponível na conta. */
    get visionFallbackModels() { return envStr('OPENAI_VISION_FALLBACK_MODELS', 'gpt-5-mini,gpt-4.1-mini').split(',').map(s => s.trim()).filter(Boolean); },
    /**
     * Modelo de geração/edição de imagens (Image API /images/edits).
     * Obs.: o gpt-image-1 foi desativado pela OpenAI em 23/10/2026.
     */
    get imageModel() { return envStr('OPENAI_IMAGE_MODEL', 'gpt-image-2.5-sunburst'); },
    get imageFallbackModels() { return envStr('OPENAI_IMAGE_FALLBACK_MODELS', 'gpt-image-2.5-flare,gpt-image-2').split(',').map(s => s.trim()).filter(Boolean); },
    /** Qualidade da imagem conceitual: low | medium | high. */
    get imageQuality() { return envStr('OPENAI_IMAGE_QUALITY', 'medium'); },
    /** Fidelidade à imagem de entrada nas edições (high | low). Ignorada se o modelo não suportar. */
    get imageInputFidelity() { return envStr('OPENAI_IMAGE_INPUT_FIDELITY', 'high'); },

    // ---- Textura ----
    /** Resolução obrigatória da textura (128 × 128). */
    textureSize: 128,
    /** Número máximo de cores da paleta final (pixel art nítida). */
    get paletteColors() { return envInt('SKIN_PALETTE_COLORS', 32, 8, 64); },
    /** Tentativas de geração do conceito caso o alinhamento fique ruim. */
    get conceptAttempts() { return envInt('SKIN_CONCEPT_ATTEMPTS', 2, 1, 3); },
    /** Se a IA de imagem falhar, monta uma skin simplificada a partir da paleta analisada. */
    get allowProceduralFallback() { return envBool('SKIN_ALLOW_PROCEDURAL_FALLBACK', true); },
    /** Envia também o pacote .mcpack junto com o PNG. */
    get exportMcpack() { return envBool('SKIN_EXPORT_MCPACK', true); },
    /** Mantém cópias dos arquivos gerados em output/skins (útil para depuração). */
    get keepFiles() { return envBool('SKIN_KEEP_FILES', false); },

    // ---- Limites, desempenho e segurança ----
    get maxImageBytes() { return envInt('SKIN_MAX_IMAGE_MB', 8, 1, 25) * 1024 * 1024; },
    get maxImageDimension() { return envInt('SKIN_MAX_IMAGE_DIMENSION', 8000, 256, 16000); },
    get maxPromptLength() { return envInt('SKIN_MAX_PROMPT_LENGTH', 500, 50, 2000); },
    get maxConcurrent() { return envInt('SKIN_MAX_CONCURRENT', 3, 1, 10); },
    get maxQueue() { return envInt('SKIN_MAX_QUEUE', 50, 0, 200); },
    get cooldownSeconds() { return envInt('SKIN_COOLDOWN_SECONDS', 0, 0, 86400); },
    get dailyLimit() { return envInt('SKIN_DAILY_LIMIT', 999999, 1, 9999999); },
    /** Números (somente dígitos, separados por vírgula) sem limite de uso. */
    get adminNumbers() { return envStr('SKIN_ADMIN_NUMBERS', '').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean); },
    /** Tempo máximo total de uma geração (segundos). */
    get jobTimeoutMs() { return envInt('SKIN_TIMEOUT_SECONDS', 240, 30, 900) * 1000; },
    /** Tempo máximo de cada requisição à OpenAI (segundos). */
    get requestTimeoutMs() { return envInt('OPENAI_REQUEST_TIMEOUT_SECONDS', 180, 10, 600) * 1000; },
    /** Por quanto tempo uma imagem enviada pelo usuário fica disponível para o !criarskin (segundos). */
    get recentImageTtlMs() { return envInt('SKIN_RECENT_IMAGE_TTL_SECONDS', 600, 30, 86400) * 1000; },

    tempDir: path.resolve(__dirname, '..', 'tmp', 'skins'),
    outputDir: path.resolve(__dirname, '..', 'output', 'skins')
  }
};
