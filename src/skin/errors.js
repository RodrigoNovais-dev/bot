/**
 * Erros do !criarskin com mensagens amigáveis em português para o usuário.
 * A mensagem técnica (inglês/stack) fica apenas no log do console.
 */

const USER_MESSAGES = {
    API_NOT_CONFIGURED:
        '⚙️ A integração com a OpenAI ainda não foi configurada neste bot.\n\n' +
        'Administrador: crie o arquivo *.env* na pasta do bot (use o *.env.example* como modelo), ' +
        'defina *OPENAI_API_KEY=* com a chave obtida em https://platform.openai.com/ e reinicie o bot.',
    INVALID_KEY: '🔑 A chave da OpenAI configurada no bot é inválida ou foi revogada. Avise o administrador do bot.',
    PERMISSION_DENIED: '🔒 A conta da OpenAI configurada não tem permissão para usar o modelo necessário. Avise o administrador do bot.',
    MODEL_UNAVAILABLE: '🧩 O modelo de IA configurado não está disponível para esta conta da OpenAI. O administrador deve revisar os modelos no arquivo .env.',
    QUOTA_EXCEEDED: '💳 O limite de créditos/uso da conta OpenAI do bot foi atingido. Tente novamente mais tarde ou avise o administrador.',
    RATE_LIMITED: '🚦 A IA está recebendo muitas solicitações agora. Aguarde um minuto e tente de novo.',
    TIMEOUT: '⏱️ A criação da skin demorou demais e foi cancelada. Tente novamente em instantes.',
    CONTENT_BLOCKED: '🚫 A descrição ou a imagem foi recusada pelo filtro de segurança da IA. Tente uma descrição diferente.',
    GENERATION_FAILED: '❌ Não consegui gerar a skin desta vez. Tente novamente em instantes.',
    NETWORK: '🌐 Não consegui me comunicar com a OpenAI (falha de conexão). Tente novamente em instantes.',
    INVALID_IMAGE: '🖼️ Não consegui ler a imagem enviada. Envie uma foto válida (JPG, PNG ou WebP).',
    IMAGE_TOO_LARGE: '📦 A imagem enviada é muito grande. Envie uma imagem menor.',
    IMAGE_DOWNLOAD_FAILED: '📥 Não consegui baixar a imagem do WhatsApp. Envie a imagem novamente junto com o comando.',
    UV_FAILED: '🧱 Ocorreu um erro ao montar o mapeamento UV da skin. Tente novamente.',
    INVALID_TEXTURE: '🧪 A textura gerada não passou na validação técnica e não foi enviada. Tente novamente.',
    SEND_FAILED: '📤 A skin foi criada, mas houve uma falha ao enviá-la pelo WhatsApp. Tente novamente.',
    USER_BUSY: '⏳ Você já tem uma skin sendo criada. Aguarde ela ficar pronta antes de pedir outra.',
    COOLDOWN: '🕒 Aguarde um pouco antes de criar outra skin.',
    DAILY_LIMIT: '📅 Você atingiu o limite diário de skins. Tente novamente amanhã.',
    QUEUE_FULL: '🚧 Muitas skins estão sendo criadas agora. Tente novamente em alguns minutos.',
    BAD_ARGS: '❌ Comando inválido.',
    INTERNAL: '❌ Ocorreu um erro inesperado ao criar a skin. Tente novamente.'
};

class SkinError extends Error {
    /**
     * @param {keyof USER_MESSAGES} code Código do erro.
     * @param {string} [detail] Detalhe técnico (somente log).
     * @param {object} [extra] Dados extras (ex.: { userMessage, cause }).
     */
    constructor(code, detail, extra = {}) {
        super(detail || code);
        this.name = 'SkinError';
        this.code = USER_MESSAGES[code] ? code : 'INTERNAL';
        this.userMessage = extra.userMessage || USER_MESSAGES[this.code];
        if (extra.cause) this.cause = extra.cause;
        /** Indica se a falha é "culpa" do usuário (não devolve a cota). */
        this.chargeable = Boolean(extra.chargeable);
    }
}

/** Converte qualquer erro em SkinError. */
function toSkinError(err, fallbackCode = 'INTERNAL') {
    if (err instanceof SkinError) return err;
    return new SkinError(fallbackCode, err?.message || String(err), { cause: err });
}

module.exports = { SkinError, toSkinError, USER_MESSAGES };
