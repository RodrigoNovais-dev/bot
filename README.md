# Bot de Figurinhas para WhatsApp 🤖

Este é um bot simples e poderoso para WhatsApp capaz de transformar imagens em figurinhas (stickers) automaticamente. Feito com Node.js e a biblioteca Baileys.

## Funcionalidades
- Criação automática de figurinhas a partir de imagens enviadas.
- Conversão de documentos (que contenham imagens) em figurinhas.
- Comando `!sticker` ao responder imagens para conversão manual.
- Comandos `!ping` (teste de online) e `!menu` (exibir comandos).
- Auto-reconexão após queda de internet ou de sistema.
- Não processa as próprias mensagens, prevenindo loops.

## Pré-requisitos
Para rodar este bot, você precisará ter o Node.js instalado no seu computador.
1. Baixe o Node.js (versão LTS recomendada) de https://nodejs.org/pt-br/ e instale.
2. Certifique-se de que ele foi adicionado ao PATH do seu sistema durante a instalação (marque a caixinha se o instalador perguntar).
3. Verifique se a instalação foi bem-sucedida abrindo o terminal e digitando:
   `node -v`
   e
   `npm -v`

## Como Instalar e Rodar

1. **Abra a pasta do projeto no Terminal/VS Code:**
   Navegue até a pasta do projeto (ou abra o projeto diretamente no Visual Studio Code e abra o terminal integrado: `Terminal -> New Terminal`).

2. **Instale as dependências:**
   Com o Node.js instalado, digite o seguinte comando no terminal do projeto para instalar todas as bibliotecas necessárias (Baileys, Sharp, etc.):
   ```bash
   npm install
   ```

3. **Inicie o Bot:**
   Após a instalação, inicie o bot rodando:
   ```bash
   npm start
   ```

4. **Conecte o WhatsApp:**
   Um QR Code enorme aparecerá no seu terminal.
   - Abra o WhatsApp no seu celular.
   - Vá em "Aparelhos Conectados" > "Conectar um Aparelho".
   - Escaneie o QR Code que está na tela do seu terminal.

Pronto! Quando a mensagem "Conexão aberta! O bot está pronto para receber mensagens." aparecer, o bot já estará operando.

## Hospedagem gratuita no Render

O `render.yaml` configura um Web Service Docker no plano Free. Após 15 minutos sem tráfego de entrada, o Render suspende o serviço. Abra o endereço público do serviço com `/health` no final para acordá-lo. Os lembretes ficam no disco temporário. O horário dos lembretes é o de São Paulo.

1. Publique o código em um repositório privado, incluindo `Dockerfile`, `.dockerignore` e `render.yaml`. Mantenha `.env`, `auth_info_baileys/` e `lembretes.json` fora do repositório.
2. No [painel do Render](https://dashboard.render.com/), escolha **New → Blueprint**, conecte o repositório e confira se o serviço aparece no plano **Free**.
3. Em **Environment** do serviço, configure `OPENAI_API_KEY` para habilitar `!criarskin` e adicione as demais variáveis do seu `.env` que você usa.
4. Encerre o bot local. Abra **Logs** no serviço e escaneie o QR Code pelo WhatsApp em **Aparelhos conectados → Conectar um aparelho**. Depois de aparecer **Conexão aberta!**, envie `!ping`.

### Reconectar sem escanear o QR Code a cada suspensão

1. Crie um banco Redis no plano Free do Upstash para este bot. Na aba **REST**, copie a URL e o token com permissão de escrita.
2. Em **Environment** no Render, adicione `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` e `WA_SESSION_KEY`. Gere a última no terminal com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Guarde a chave para que o bot consiga ler a sessão após reinícios.
3. Após o deploy com essas variáveis, escaneie o QR Code uma vez. A sessão será armazenada criptografada no Redis. Para acordar o serviço depois, abra o endereço público com `/health` e aguarde a reconexão antes de enviar `!ping`.

### Acordar o Render com uma mensagem no WhatsApp

Para receber mensagens por webhook, cadastre um número na WhatsApp Cloud API da Meta. Use o número de teste da Meta para validar o fluxo antes de cadastrar o número definitivo.

1. Em **Environment** no Render, adicione `WA_CLOUD_ENABLED=1`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_GRAPH_VERSION` (por exemplo, a versão exibida no painel da Meta) e `WA_VERIFY_TOKEN` (um segredo aleatório que você gera e reutiliza na próxima etapa). Salve para iniciar o deploy.
2. Na configuração de webhooks da Meta, informe a URL pública do Render com `/webhook/whatsapp` no final e o mesmo `WA_VERIFY_TOKEN`. Assine o campo **messages** e confira se o aplicativo está inscrito na conta do WhatsApp Business.
3. Envie `!ping` em uma conversa privada para o número cadastrado. A Meta envia a mensagem ao Render e o serviço pode levar cerca de um minuto para sair da suspensão.

Nesse modo, o bot usa a Cloud API e dispensa QR Code. Envie a mídia diretamente para criar uma figurinha. Os grupos atuais e as respostas a mídias antigas dependem do modo Baileys. Para voltar a ele, remova `WA_CLOUD_ENABLED`.

## Como Usar o Bot
Você pode testar o bot enviando mensagens do seu próprio número (ou de outro, mas é recomendável testar de outro para garantir a fluidez).

- **Criar Figurinha:** Basta enviar qualquer foto para a conta do bot (como imagem comum) e o bot responderá com a figurinha!
- **Criar Figurinha Manual (`!sticker`):** Se alguém mandou uma foto, você pode responder essa foto com a mensagem `!sticker` e o bot transformará em figurinha.
- **Ajuda e Teste:**
  - Envie `!ping` para testar se o bot está vivo.
  - Envie `!menu` para ver o texto de ajuda.
- **Criar Skin 128×128 para Minecraft Bedrock (`!criarskin`):**
  - **Por texto:** `!criarskin um ninja preto com olhos vermelhos, capuz e detalhes roxos`
  - **Escolhendo o modelo (`classic` ou `slim`):**
    - `!criarskin --modelo classic ninja preto com olhos vermelhos`
    - `!criarskin --modelo slim exploradora futurista`
  - **Por imagem:** envie uma foto com a legenda `!criarskin` (ou envie a sua foto primeiro e digite `!criarskin` em seguida). O bot nunca utiliza imagens enviadas por outros usuários.

## Configuração do Comando `!criarskin` (OpenAI)

1. Crie uma chave de API na plataforma oficial da OpenAI: https://platform.openai.com/api-keys
2. Na raiz do projeto (`c:\Users\rodri\Downloads\bot`), copie o arquivo `.env.example` para `.env`:
   ```powershell
   Copy-Item .env.example .env
   ```
3. Abra o arquivo `.env` no Visual Studio Code e preencha sua chave real:
   ```env
   OPENAI_API_KEY=sk-proj-...
   ```
4. Para executar os testes automatizados do sistema de skins:
   ```powershell
   npm test
   ```

## Compatibilidade Técnica de Skins 128 × 128 no Minecraft Bedrock

- O **Minecraft Bedrock Edition** aceita nativamente três tamanhos de textura RGBA para skins clássicas: `64 × 32`, `64 × 64` e **`128 × 128` pixels** (`128 × 128 × 4 = 65.536 bytes` RGBA), utilizando as geometrias `geometry.humanoid.custom` (modelo **Classic**, braços de 4 unidades / 8 px em HD) e `geometry.humanoid.customSlim` (modelo **Slim**, braços de 3 unidades / 6 px em HD).
- As coordenadas UV de `128 × 128` seguem exatamente o layout `64 × 64` escalado por `2×` (cabeça, tronco, braços direito/esquerdo e pernas direita/esquerda).
- O comando `!criarskin` entrega:
  1. **O arquivo `.png` original de `128 × 128` pixels (RGBA, 8 bits)** enviado como documento sem compressão do WhatsApp (preservando transparência e pixels exatos), importável diretamente no Vestiário (*Dressing Room* -> *Skins Clássicas* -> *Escolher Nova Skin*) no Windows, Android e iOS.
  2. **O pacote `.mcpack` opcional** estruturado como arquivo ZIP real contendo `manifest.json` (`skin_pack`), `skins.json`, `texts/pt_BR.lang`, `texts/en_US.lang`, `texts/languages.json` e o `skin.png` de `128 × 128`.
  - *Nota técnica:* Em consoles (Xbox, PlayStation, Nintendo Switch), o Minecraft Bedrock bloqueia a importação de arquivos locais avulsos (`.png` ou `.mcpack`) por restrição da plataforma; nesses sistemas, skins personalizadas externas só aparecem se importadas em outra plataforma conectada ou via servidor compatível.

## Solução de Problemas (Erros Comuns)
- **Erro de 'npm não reconhecido':** Significa que o Node.js não está instalado no seu computador, ou não foi adicionado ao PATH do Windows. Reinicie o PC após instalar o Node.js.
- **O bot desconectou e não reconecta:** Se você deslogar manualmente no celular, a sessão no computador morre. Para corrigir, apague a pasta `auth_info_baileys` deste projeto e rode `npm start` de novo para gerar um novo QR Code.
- **Erros de "sharp":** A biblioteca `sharp` às vezes necessita que o sistema tenha algumas ferramentas de compilação C++, mas ela possui binários pré-compilados. Se der erro ao instalar, confira a documentação do Sharp ou garanta estar usando uma versão atualizada do Node.

## Como manter o bot online?
Enquanto a tela preta do terminal (cmd, powershell ou o terminal do VSCode) estiver aberta com o comando `npm start` rodando, o bot funcionará, mesmo que o celular seja desligado. Para manter sempre funcionando (24/7), seria necessário hospedar esse código em um servidor na nuvem (como um VPS na Hostinger, DigitalOcean, AWS, etc).
