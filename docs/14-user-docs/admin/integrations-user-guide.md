# Guia do usuário — Central de Integrações

> Status: Baseline (S5C, #89)
> Onde fica: no painel, abra **Configurações > Integrações** (`/settings/integrations`).
> Este guia acompanha a tela real: cada cartão mostra estado, ambiente, última
> verificação, último erro e os botões Conectar, Testar, Reautorizar,
> Configurar e Desconectar.

A Central de Integrações liga o seu painel aos três serviços externos:
**Asaas** (cobranças: boletos e PIX), **WhatsApp** (atendimento e avisos) e
**CINEVISION** (servidor e ativações). Você conecta cada um **separado**, no
seu ritmo — dá para usar o modo manual enquanto uma integração não está
ligada, e a tela sempre diz o que continua indisponível.

## O que cada estado significa

Na parte de cima de cada cartão aparecem dois estados:

**Conexão** (a sua conta naquele serviço):

| Estado na tela | O que quer dizer |
|---|---|
| Não configurado | Nada foi conectado ainda. |
| Rascunho | Os dados foram salvos, mas ainda não foram testados. Use **Testar**. |
| Em teste | O último teste não passou. Veja o erro abaixo do cartão e tente de novo. |
| Conectado (somente leitura) | A conta foi validada. Cobranças, envios e ativações automáticas ainda dependem da etapa de liberação. |
| Pronto para piloto | Liberado para os primeiros usos reais acompanhados. |
| Ativo | Funcionando normalmente. |
| Degradado | Funciona com limitação (a tela diz qual). |
| Reautorização necessária | A credencial parou de valer. Reconfigure com dados válidos. |
| Desativado | Você pausou a integração. O histórico (faturas, mensagens, clientes) continua guardado. |

**Capacidade** (o que a plataforma libera para você): Disponível,
Degradada, Indisponível, Não certificada ou Desconhecida. Conectar a conta
**não** libera tudo sozinho — efeitos com dinheiro, mensagens e ativações
só funcionam depois da validação de cada etapa.

## 1. Conectar o Asaas (cobranças)

1. No cartão **Asaas (Cobranças)**, clique em **Conectar**.
2. Escolha o **ambiente**: comece por **Sandbox** (testes, sem dinheiro de
   verdade). Só mude para **Produção** quando tudo estiver validado.
3. Cole a **chave de API** do Asaas no campo protegido e confirme. A chave é
   enviada uma única vez e guardada no cofre — ela nunca mais aparece na tela.
4. Clique em **Testar**. Se der certo, o estado vira
   **Conectado (somente leitura)**.
5. Configure o **webhook** (o aviso automático de "pagamento recebido"):
   - **Automático (recomendado):** use o botão de configurar webhook do
     cartão. O painel cria o aviso na sua conta Asaas sozinho.
   - **Manual:** a tela mostra a URL do webhook do seu painel. Copie essa URL
     para o dashboard do Asaas (eventos de pagamento, envio sequencial) com
     um token próprio (uma senha de 32 a 255 letras/números, **diferente** da
     chave de API). Depois valide com um pagamento de teste no Sandbox.
6. Só habilite cobranças em **Produção** por um ato explícito seu, com as
   contas e os valores conferidos.

## 2. Conectar o WhatsApp (atendimento)

1. No cartão **WhatsApp (Atendimento)**, clique em **Conectar**. O painel cria
   uma sessão exclusiva da sua conta.
2. Clique em **ver QR** e aponte a câmera do WhatsApp do celular para o
   código na tela. O QR **expira em segundos** — se vencer, atualize e leia o
   novo. O código só aparece enquanto a sessão está **aguardando leitura**.
3. Quando o estado virar **Conectada**, envie uma **mensagem de teste** para
   um número seu autorizado e confira se chegou.
4. Se algo falhar, use **Reconectar**. **Desconectar** pausa os envios mas
   apaga nada do histórico.

O que cada estado da sessão quer dizer: **Parada** (desligada),
**Iniciando** (ligando, aguarde), **Aguardando leitura do QR** (leia o código),
**Conectada** (pronta), **Falha** (use Reconectar).

## 3. Conectar a conta CINEVISION (servidor)

1. No cartão **CINEVISION (Servidor/Ativação)**, clique em **Conectar** e
   informe o **usuário e a senha do painel CINEVISION**. Eles vão para o
   cofre e nunca mais aparecem na tela.
2. Clique em **Testar**. O painel confere a conta com uma leitura segura
   (sem criar nem mudar nada lá dentro).
3. Se o painel CINEVISION pedir verificação humana (código, CAPTCHA ou tela
   de segurança), conclua o acesso **direto no painel CINEVISION** e repita o
   teste. Não existe atalho para essa etapa.
4. Para trazer seus clientes atuais: clique em **pré-visualizar importação**,
   confira a lista (o painel separa o que é **novo**, o que já existe
   (**duplicado**) e o que precisa de revisão (**conflito**)) e só então
   confirme. Nada é criado antes da sua confirmação.
5. Enquanto a ativação automática não estiver liberada, ative e renove
   **manualmente no painel CINEVISION** — o guia do operador reconcilia o
   resto depois.

## 4. Quando der erro: o que fazer

Abaixo do cartão aparece a dica em português. Este é o resumo:

| Mensagem | O que fazer |
|---|---|
| Credenciais inválidas | Confira a chave de API (Asaas) ou usuário/senha (CINEVISION) e conecte de novo. |
| Provedor indisponível | Aguarde um pouco e clique em **Testar** de novo. |
| Tempo esgotado | Tente **Testar** de novo; se continuar, veja se o site do serviço está no ar. |
| Reautorização necessária | A credencial venceu: reconfigure com dados válidos. |
| Verificação humana necessária (CINEVISION) | Entre no painel CINEVISION, conclua a verificação e repita o teste. |
| Limite do provedor (WhatsApp) | O WhatsApp pediu uma pausa (não é desconexão). Aguarde e atualize a tela; não fique reenviando. |
| QR indisponível | A sessão já pareou, parou ou o código venceu: atualize o estado e gere um novo. |
| Webhook pendente (Asaas) | Termine a configuração do webhook (automática ou manual) e valide com um evento de teste. |
| Recurso ainda não certificado | Aquela função ainda não foi liberada para testes — fale com o suporte. |

Regras que valem para tudo: **Desconectar pausa, não apaga** (faturas,
mensagens e clientes continuam lá). Trocar a credencial pede confirmação e
volta o cartão para **Rascunho** até o próximo teste. Sem permissão de
administrador, você só consulta o estado — os botões de alterar ficam
bloqueados.

## 5. Roteiro de começo em 10 passos

1. Entre no painel e complete os dados da **conta e da equipe**.
2. Monte o **catálogo** (planos e preços).
3. Conecte o **Asaas em Sandbox** e teste.
4. Configure o **webhook do Asaas** (automático ou manual) e valide com um
   pagamento de teste.
5. Conecte o **WhatsApp**: leia o QR e envie uma mensagem de teste.
6. Conecte a **conta CINEVISION** e valide a leitura.
7. **Importe os clientes atuais** com pré-visualização + confirmação.
8. Rode os **testes sem efeito** (testar cada cartão, conferir estados e erros).
9. Faça o **go-live explícito**: mude o Asaas para Produção somente quando
   tudo acima estiver verde.
10. **Acompanhe a saúde** pelos cartões (última verificação e último erro) e
    chame o suporte diante de qualquer estado que este guia não explique —
    não improvise.

## 6. O que continua manual (sem susto)

- Sem o Asaas em Produção liberado, cobranças reais são feitas fora do
  painel; o modo de teste nunca movimenta dinheiro.
- Sem o WhatsApp conectado, os avisos saem por outro canal combinado com o
  suporte; mensagens de teste têm limite anti-spam.
- Sem a ativação automática CINEVISION liberada, ativações e renovações são
  feitas no painel CINEVISION.
- Desconectar qualquer integração **nunca apaga** faturas, mensagens,
  clientes ou provas de importação — só pausa os efeitos novos.
