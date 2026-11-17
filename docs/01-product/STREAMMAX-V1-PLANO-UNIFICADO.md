# StreamMax V1 — Plano do produto unificado

> **Decisão de produto (16/11/2026):** concluir primeiro um produto comercial para a operação própria StreamMax. **SaaS para outros operadores fica para uma fase posterior.**  
> **Estado deste documento:** planejamento aprovado em direção; implementação, limpeza, homologação e release **a executar**. Este documento não certifica produção.  
> **Repositórios:** [Kusts/iptv](https://github.com/Kusts/iptv) (produto) e [Kusts/OpenMausBot](https://github.com/Kusts/OpenMausBot) (motor compartilhado de bots).

## 1. Resultado que precisamos entregar

Um único produto capaz de conduzir, registrar e operar a jornada de um cliente final:

**WhatsApp → identificação/lead → catálogo e teste (se elegível) → pedido → PIX Asaas → pagamento confirmado → ativação verificada CINEVISION (manual supervisionada, inicialmente) → assinatura ativa → suporte → renovação.**

O operador acompanha exceções e resultados pelo painel StreamMax. O cliente não precisa conhecer nem acessar dois sistemas. A IA atende, entende, encaminha e solicita ações reais; o backend registra estados, aplica regras de negócio e executa operações. Nenhum bot deve afirmar pagamento, ativação ou renovação sem resposta verificada.

### Público, canal e entrega inicial

- **Público:** clientes finais da própria operação StreamMax; um tenant operacional.
- **Canal principal:** WhatsApp; painel web para o operador.
- **Produto vendido:** somente catálogo e condições comerciais aprovados. Não inferir preço, compatibilidade, conteúdo, prazo ou duração do teste a partir de seeds e fixtures.
- **Fornecedor:** CINEVISION. Sem chave/API homologada, a ativação/consulta é manual supervisionada e registrada no StreamMax; automação posterior não bloqueia a V1 quando houver fallback operacional.
- **Expansão futura:** produto SaaS para operadores externos, campanhas complexas, marketplace, rede de revendedores, white-label e integrações opcionais.

## 2. Princípios para esta missão

1. **Fazer o menor caminho funcional primeiro:** um cliente, um canal, um pedido, uma cobrança, uma assinatura.
2. **Reutilizar antes de criar:** endpoints, telas, worker, migrations, bots, skills e bridges existentes.
3. **Uma responsabilidade, uma fonte de verdade:** nenhum cadastro, ledger, cobrança ou ativação com dois escritores independentes.
4. **Remover código morto comprovado:** antes de excluir, verificar usos, imports, rotas, runtime, testes, scripts, deploy e rollback. Arquivo antigo não é automaticamente arquivo morto.
5. **Entrega em fatias verticais:** cada etapa implementa comportamento observável, testa e atualiza documentação.
6. **Autonomia técnica do Planner OpenCode:** decidir detalhes de implementação e corrigir falhas sem pedir autorização para microtarefas; operações com efeitos externos reais, segredos, dados reais ou exclusões irreversíveis dependem da autorização pertinente.
7. **Sem reescrita generalizada:** preservar comportamentos validados e não adicionar novos serviços/frameworks quando os atuais atendem.

## 3. Arquitetura de destino (enxuta)

```text
Cliente WhatsApp
      |
   WAHA / ponte única de mensagens
      |
   OpenMausBot — equipe StreamMax
   Atendimento | Financeiro | Suporte | CINEVISION | Chefe
      |
      | ferramentas/contratos autorizados
      v
   API StreamMax (NestJS)
   CRM | catálogo | pedidos | cobrança | assinatura | suporte
      |
   PostgreSQL StreamMax (dados de negócio oficiais)
      |
   outbox worker já existente
      |
   Asaas (cobranças) / CINEVISION (ativação manual; API futura)

   Painel Next.js StreamMax ---> mesma API
```

### Limites e propriedade

| Área | Dono definitivo na V1 | Regra de consolidação |
|---|---|---|
| Cliente/lead, planos, preços, pedido, pagamento, assinatura, ticket | API + PostgreSQL StreamMax | OpenMausBot nunca vira outro banco transacional |
| Conversa, interpretação, contexto da thread e delegação | OpenMausBot e ponte WhatsApp | Preservar contato/identidade, vinculando-o ao cliente oficial pela API |
| Envio e recebimento no WhatsApp | **Um** pipeline WAHA ativo para a operação | Auditar WAHA/bridge do bot e Inbox/WAHA do StreamMax; eleger um receptor/roteador e desativar duplicações depois do E2E |
| PIX, webhooks e conciliação | StreamMax + Asaas | Bot Financeiro consulta por ferramentas autorizadas; webhook/inbox próprio do OpenMausBot é candidato a descontinuação quando o pipeline oficial estiver comprovado |
| Ativação e renovação do serviço | StreamMax, com confirmação CINEVISION | Bot Gestor orienta/solicita; operador executa no fornecedor até homologação real |
| Estados duráveis e recuperação | StreamMax/outbox existente | Não ativar processadores concorrentes do mesmo evento; não adicionar Hatchet por padrão |
| Configuração compartilhada do OpenMausBot | Repositório OpenMausBot | Manter motor reutilizável para outros projetos; código e conhecimento específicos StreamMax devem ter **um** local canônico, decidido na migração, sem duas cópias editáveis |
| Infraestrutura geral | Repositório de infraestrutura da VPS | Não copiar stacks, bancos ou segredos de outros projetos |

**Decisão de repositórios:** não fundir o código-base genérico do OpenMausBot ao monorepo IPTV. O **produto entregue é único**, com StreamMax como repositório de produto e OpenMausBot como dependência compartilhada. A auditoria definirá a melhor forma de versionar e distribuir os artefatos específicos da equipe IPTV sem bifurcar sua fonte.

### Contrato mínimo entre bots e produto

Começar pelas ferramentas de negócio existentes, criando uma camada fina de adaptação apenas se faltar uma interface. Os nomes abaixo representam **capacidades desejadas**, não endpoints já comprovados:

- Resolver/criar lead por identificador de contato e consultar cadastro autorizado.
- Consultar catálogo, preços e elegibilidade de trial.
- Criar/consultar pedido sem duplicação; solicitar cobrança; consultar estado confirmado do pagamento.
- Solicitar ativação e consultar assinatura, vencimento e estado operacional.
- Solicitar renovação e acompanhar resultado.
- Criar/consultar ticket de suporte e registrar transferência humana.

Empregar autenticação de serviço e isolamento do tenant na fronteira da API, sem dar acesso SQL direto aos bots. Reutilizar controllers/comandos existentes e manter confirmação idempotente de operações financeiras. Bot não substitui máquina de estados nem lógica do backend.

## 4. Fotografia conhecida — não confundir com produção

**IPTV, evidência datada de 15/11/2026** ([snapshot](../16-pilot-closure/STREAMMAX-MVP-STATUS-2026-11-15.md)):

- `MVP_STREAMMAX_OPERATIONAL` interno registrou **4/4 gates PASS**, em staging. Isso **não** aprova `MVP-PILOT`, `MVP-SAAS` nem a nova V1 comercial integrada aos bots.
- API, web, PostgreSQL, ledger, outbox, renovação e suporte possuem software/testes. Jornada de cobrança foi sintética, com evento Asaas Sandbox simulado.
- CINEVISION teve ativação manual supervisionada com readback no painel; escrita automática não homologada.
- O staging documentado rodava `main@89b3f3a`; a `main` do repositório foi atualizada depois. Novo candidato exige identificar commit e ambiente exatos.

**OpenMausBot, evidência datada de 16/11/2026** ([equipe](https://github.com/Kusts/OpenMausBot/blob/main/teams/iptv/team.yaml), [avaliação comercial](https://github.com/Kusts/OpenMausBot/blob/main/docs/bots/atendimento-comercial-avaliacao.md)):

- Cinco bots IPTV configurados: Chefe, Atendimento, Financeiro, Suporte e Gestor CINEVISION.
- Atendimento V3 melhorou avaliação sintética: 87/90 nos cenários isolados e 33/36 nos multimensagem, **mas ainda com suposições, prazos sem fonte e pendências não retomadas**.
- A ponte WAHA, CLI Asaas e webhook do OpenMausBot existem; sua conexão operacional com o modelo oficial de clientes/pedidos da API StreamMax ainda não está provada.
- A própria base do bot registra catálogo de preços real e acesso de serviço à API StreamMax como pendências.
- Não há teste demonstrado de venda comercial ponta a ponta integrando WhatsApp real, bot, StreamMax, Asaas real e fornecedor.

**Conclusão:** os dois projetos são **parcialmente implementados**, com componentes aproveitáveis. A V1 não está pronta para comercialização apenas por terem smoke/CI verdes.

## 5. Escopo funcional da V1

| Capacidade | Critério mínimo de aceite | Fora agora |
|---|---|---|
| Primeiro contato e conversão | Bot recebe, entende intenção, informa oferta vigente, registra lead e propõe próximo passo concreto | CRM de marketing complexo |
| Identidade e histórico | Uma pessoa/contato liga conversa, pedido, cobrança, assinatura e ticket; sem nomes de outras threads | Perfil unificado multicanal |
| Planos, ofertas e teste | Preços aprovados e teste conforme elegibilidade configurada; falha técnica bloqueia venda indevida | A/B de ofertas e gamificação |
| Venda/PIX | Pedido único, link/cobrança correta, confirmação por webhook autenticado, status sincronizados | Métodos raros sem demanda |
| Entrega CINEVISION | Operador recebe tarefa, ativa e confirma referência/estado; cliente só recebe confirmação após readback | Escrita automática sem chave/homologação |
| Suporte | Diagnóstico simples, ticket no StreamMax, contexto e escalonamento humano | Central omnichannel sofisticada |
| Renovação/fidelização | Consultar vencimento, gerar pedido de renovação, estender período após pagamento e registrar acompanhamento | Campanhas sofisticadas |
| Painel operacional | Ver clientes, pedidos, cobrança, assinaturas, pendências de ativação e tickets em dados reais | Platform Admin para terceiros |
| Recuperação | Falha/retry não duplica cobrança, ativação ou extensão; operador pode retomar pendência | Novo motor de workflows |

**SaaS multi-tenant externo NÃO integra a V1.** Não remover automaticamente estruturas existentes de tenancy/RLS/RBAC: avaliar dependências e manter isolamento que já sustenta o backend. Desativar escopo não usado é preferível a apagar componentes que ainda participam de operações.

## 6. Plano de execução (consolidação + desenvolvimento restante)

### M0 — Auditoria executável e mapa de cortes

- Inventariar `main` atual dos dois repositórios, código, dependências, rotas, workers, webhooks, bancos, configurações e estado do staging **sem alteração da VPS**.
- Criar matriz por componente: `MANTER`, `INTEGRAR`, `CONCLUIR`, `REMOVER APÓS TESTE`, `PÓS-V1`, com dono, evidência de uso, dependências e risco de remoção.
- Confrontar o código realmente carregado com documentação e scripts. Inspecionar em especial: runtime IA interno vs OpenMausBot; Inbox/WAHA duplicados; Asaas CLI/webhook; workers de outbox; dashboards, módulos e dependências SaaS; scripts antigos.
- Definir 1 entrada WhatsApp, 1 pipeline de pagamento e 1 cadastro de clientes como desenho de destino; mapear migração/rollback.
- **Saída:** inventário versionado, cortes aprovados tecnicamente, primeiro caso E2E selecionado. Não gastar a fase inteira com documentação.

### M1 — Primeira fatia funcional: atendimento → cliente

- Usar ponte WAHA já existente (ou a do produto, se auditoria demonstrar vantagem), em apenas um caminho ativo.
- Integrar Atendimento à API StreamMax para resolver/criar lead e consultar catálogo de preços aprovados.
- Testar conversa com contato sintético, inclusive repetição e retomada de contexto, sem enviar mensagens externas não autorizadas.
- Remover apenas código duplicado comprovadamente substituído e atualizar documentação do fluxo.
- **Aceite:** mensagem chega → bot consulta/cria lead no StreamMax → resposta usa dados oficiais → segunda mensagem reaproveita cliente, sem duplicação.

### M2 — Venda e cobrança realista

- Integrar escolha de plano, pedido e PIX à API/cobrança oficial StreamMax.
- Fazer Asaas Sandbox E2E com callback/replay e painel; homologar configuração do tenant.
- Migrar funções úteis do bot Financeiro para consultas à API StreamMax e retirar o pipeline financeiro paralelo quando comprovado.
- **Aceite:** pedido → cobrança → confirmação por webhook → estado único no painel e no bot; reenvio de evento não duplica efeito.

### M3 — Entrega, suporte e renovação

- Ativação CINEVISION **manual supervisionada** vinculada ao pedido e assinatura; nenhuma confirmação otimista.
- Habilitar consulta de vencimento, renovação, extensão correta de prazo e suporte com ticket, usando a mesma identidade.
- Refinar os cinco bots com cenários conversacionais reais e testes de delegação; não criar sexto bot sem lacuna comprovada.
- **Aceite:** ativação verificada → assinatura ativa → suporte acessa histórico → renovação paga estende uma única vez, incluindo retries.

### M4 — Limpeza final, documentação e preparação do piloto

- Eliminar artefatos redundantes agora efetivamente desligados, com inventário antes/depois e rollback.
- Alinhar painel, API, bots, integrações e versionamento; fechar ou reclassificar issues antigas com evidência, sem apagar histórico.
- Atualizar README, AGENTS, arquitetura, contratos afetados, runbooks, documentação comercial e instruções dos bots com o comportamento observado.
- Validar backup/restore, configuração de borda, autenticação e logs pertinentes ao atendimento/cobrança; não abrir componentes SaaS externos.
- **Aceite:** suíte verde, jornada E2E completa em staging, procedimento de implantação e recuperação praticado.

### M5 — Piloto de produção controlado

- Confirmar catálogo, preço, política de teste, número WhatsApp e conta Asaas de produção.
- Com autorização para ações externas, realizar primeira venda real, confirmação, ativação supervisionada, suporte e **primeira renovação real**. Confrontar valores, datas e estados em Asaas, StreamMax e CINEVISION.
- Corrigir defeitos observados e ampliar atendimento somente após estabilidade da primeira operação.
- **Aceite:** fluxo de um cliente real auditável ponta a ponta, sem falsos status, eventos duplicados ou dependência de lançamentos manuais ocultos no banco.

**Ordem é por dependência, não por burocracia:** subetapas independentes podem andar em paralelo. Quando aparecer lacuna concreta, fazer a menor correção funcional, reproduzir, testar e registrar.

## 7. Backlog inicial prioritário

| Prioridade | Trabalho | Referência / estado |
|---|---|---|
| P0 | Identificar fluxo WAHA único e integrar bot à API StreamMax com identidade do cliente | Novo trabalho de consolidação |
| P0 | Catálogo comercial vigente e fluxo de pedido/PIX unificado | Operador fornece condições; software existente será reaproveitado |
| P0 | Confirmar webhook Asaas oficial, sem duplicar processamento | [#86](https://github.com/Kusts/iptv/issues/86) |
| P0 | Fluxo CINEVISION manual verificável + suporte/renovação | [#88](https://github.com/Kusts/iptv/issues/88) |
| P1 | Caminhada autenticada do painel e integração WhatsApp homologada | [#89](https://github.com/Kusts/iptv/issues/89), [#87](https://github.com/Kusts/iptv/issues/87) |
| P1 | Corrigir falhas observadas no Atendimento V3 e validar conversas multimensagem | Teste sintético OpenMausBot 16/11 |
| P1 | Limpeza de código morto e duplicações **após** migração e regressão | Dependências auditadas M0 |
| P1 | Validar controles de acesso/borda e isolamento aplicáveis ao piloto | [#44](https://github.com/Kusts/iptv/issues/44), [#7](https://github.com/Kusts/iptv/issues/7) |
| Depois | MK, Hatchet, experimentação de modelos, worker alternativo, revenda e SaaS | [#58](https://github.com/Kusts/iptv/issues/58), [#4](https://github.com/Kusts/iptv/issues/4), [#27](https://github.com/Kusts/iptv/issues/27), [#1](https://github.com/Kusts/iptv/issues/1) |

As issues anteriores são insumos, **não** o novo plano por definição. O Planner deve cruzar cada uma com a V1 e fechar/adiar/reformular apenas com evidência.

## 8. Critério rigoroso para remoção de código morto

Para cada candidato:

1. Registrar arquivo/módulo, dependências, rotas, imports, cron/worker, uso no ambiente, migrations e motivo de desuso.
2. Confirmar que nenhum caminho V1 nem recuperação depende dele. `Não executado no teste` não comprova ausência de uso.
3. Desativar/migrar e executar o caso de uso substituto. Se necessário, manter alias temporário curto.
4. Remover código, testes específicos obsoletos, scripts, configuração e documentação correspondentes **juntos**; manter testes de contrato/regressão úteis.
5. Testar build, integração e rollback. Nunca editar/excluir migrations históricas, arquivos de dados, volumes ou segredos de produção para `limpar o projeto`.

Documentar ganhos observáveis (menos executores, menos webhooks, menos caminhos e dependências), sem criar métrica percentual fictícia.

## 9. Prova mínima por marco

- **Estática e contratos:** `pnpm lint`, `pnpm typecheck`, `pnpm build`; quando houver mudanças de API/docs, `python scripts/validate_docs.py` e testes de contrato correspondentes.
- **Automatizados:** `pnpm test` com `TEST_DATABASE_URL` apontando para **banco descartável vazio**; filtrar suites afetadas durante a iteração, rodar CI completo no candidato.
- **Bots:** testes versionados do OpenMausBot (`node --test teams/iptv/tests/*.test.mjs`) e cenário dirigido de conversa na execução real do bot.
- **Staging:** executar jornada conectada com cliente sintético, pedido, webhook Sandbox, ticket, ativação manual simulada/autorizada e renovação; observar API, PostgreSQL e UI **na mesma revisão**.
- **Pré-produção:** repetir com conta/número/recurso externos autorizados; não transformar mock, seed ou CLI sem envio em `produção homologada`.
- **Rollback:** verificar retorno à versão anterior sem perda de pedidos/assinaturas.

Cada entrega contém **mudança + teste executado + resultado + documento alterado + pendência concreta**. Não criar relatório extenso quando uma evidência curta basta.

## 10. Decisões comerciais ainda necessárias (não bloqueiam M0/M1 técnico)

1. Catálogo comercial vigente: planos, preços, conexão adicional, benefícios e política de renovação.
2. Política de trial: oferta ou não, duração, elegibilidade e limites.
3. Número/sessão WhatsApp exclusivos para StreamMax e regras de primeiro contato/acompanhamento.
4. Conta Asaas de produção e autorização para primeiro pagamento, em momento oportuno.
5. Credencial, escopo e uso autorizado da API CINEVISION para posterior homologação automática.
6. Confirmação de direitos para comercializar o conteúdo/serviço e das informações comerciais divulgáveis.

O Planner deve usar fixtures em fases iniciais e **não bloquear trabalho independente** enquanto esses itens aguardam definição. Nunca expor credenciais, dados pessoais ou realizar cobranças/ativação reais fora do escopo autorizado.

## 11. Documentação: fonte única e migração contínua

- **Este arquivo:** objetivo, escopo e ordem de execução **da StreamMax V1 própria**. Não declara código implementado.
- [Baseline de implementação](../15-implementation-baseline/README.md): contratos técnicos/domínio ainda válidos; qualquer alteração de regra exige reconciliar implementação e contrato, **não** sobrescrever silenciosamente.
- [Estado operacional em 15/11](../16-pilot-closure/STREAMMAX-MVP-STATUS-2026-11-15.md): evidência histórica datada; não é atestado da V1 integrada.
- [Homologação de integrações](../16-pilot-closure/INTEGRATIONS-HOMOLOGATION-2026-11-15.md) e [backlog anterior](../16-pilot-closure/BACKLOG-TRIAGE-2026-11-15.md): fotografia do momento, a revalidar.
- [Equipe de bots](https://github.com/Kusts/OpenMausBot/tree/main/teams/iptv) e [avaliação V3](https://github.com/Kusts/OpenMausBot/blob/main/docs/bots/atendimento-comercial-avaliacao.md): fonte atual de configuração do motor até migração da propriedade.
- [AGENTS.md](../../AGENTS.md), [README](../../README.md) e [CHANGELOG](../../CHANGELOG.md): atualizar com cada mudança implementada. Documentos históricos continuam identificados como históricos; não apagar provas.

**Regra de sincronização:** sempre que uma feature mudar, atualizar o trecho canônico afetado no mesmo PR. Reduzir duplicação documental após comprovar os links/consumidores; não reescrever dezenas de documentos sem necessidade.

## 12. Primeira missão delegável ao Planner

**Identificador:** `STREAMMAX-V1-M0-M1`

**Objetivo:** inventariar os dois sistemas, selecionar os caminhos que continuarão ativos e provar o primeiro fluxo WhatsApp → bot → API StreamMax → lead/catalogo → resposta, sem duplicar cadastros nem enviar cobrança/ativação real.

**Entrega obrigatória:**
- matriz manter/integrar/concluir/remover/depois, com referências concretas;
- contrato mínimo entre bot e API com permissões e responsabilidades claras;
- um E2E funcional demonstrado no staging/ambiente isolado, com evento, IDs, estados e evidência;
- primeiras remoções somente quando forem comprovadamente seguras e testadas;
- documentação e backlog reconciliados, com próximos marcos M2–M5 atualizados.

**Não é aceite:** somente diagrama, dashboard novo, relatório sem teste, `CI verde` sem jornada integrada ou declaração de produção sem pagamento/ativação realmente verificados.
