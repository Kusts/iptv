# SPEC + PLAN — Integrações self-service no Control Center

> Status: PROPOSTA para revisão (docs-only; nenhum conector live habilitado por esta mudança).
> Base auditada: `b3109a9abe0f0cd500b19ea2b9625df174e8f89a` — 2026-10-30.
> Escopo: Asaas, WhatsApp/WAHA e CINEVISION; preservar ports, RLS, CommandBus, Inbox/Outbox, Dispatcher, Infisical e ADRs vigentes.

## 1. Problema, usuário e resultado

Hoje as integrações exigem configuração por operador/servidor: Asaas seleciona adapter por `ASAAS_ADAPTER`/`ASAAS_API_KEY`/`ASAAS_BASE_URL`; WAHA seleciona `WAHA_BASE_URL`/`WAHA_API_KEY`/`WAHA_SESSION` e `waha-sessions.ts` mantém bindings num Map em memória; CINEVISION usa conta/identidade do Browser Worker por `BROWSER_WORKER_TENANT_ID` e `BROWSER_WORKER_PROVIDER_ACCOUNT_ID` no ambiente, com writes live ainda não certificados.

Resultado desejado: um administrador de tenant conecta, testa, monitora, troca e desconecta as três integrações dentro do Control Center, sem editar .env, banco, terminal ou cofre manualmente. A infraestrutura de plataforma (WAHA, Infisical, infraestrutura de workers, chaves de sistema) continua gerenciada pelo operador da plataforma; credenciais de contas dos clientes podem ser inseridas por eles no painel sem serem devolvidas ao navegador.

A tela e o fluxo já são previstos em `docs/13-product-design/screen-specs/settings-integrations.md` e `docs/13-product-design/onboarding.md`; esta SPEC detalha contratos e fatias para entrega.

## 2. Princípios inegociáveis

- **Separar conexão, validação e certificação**: `NOT_CONFIGURED → DRAFT → TESTING → CONNECTED_READ_ONLY → READY_FOR_PILOT → ACTIVE / DEGRADED / REAUTH_REQUIRED / DISABLED`. O estado de conexão não concede capability. Usar os estados canônicos `platform.capabilities` e seu gate de certificação por operação, sem criar fonte paralela de autoridade.
- **Configuração por tenant e integração**: binding persistido, nunca `Map` em processo como autoridade; sem selecionar tenant por body/header. Respeitar `AuthGuard`, `PermissionsGuard`, `withTenantTransaction` e RLS.
- **Segredos somente no cofre**: metadata + `secret_ref` nas tabelas; escrita server-side no Infisical com identidade restrita. Nunca retornar senha/API key/token/cookie, nunca expor ao Copilot/LLM, logs, traces ou payloads de erro.
- **Runtime por tenant**: resolver credencial, sessão e provider-account no contexto da operação/autorização, não via variáveis globais. Preservar os adapters atuais como compatibilidade para staging único, sem usá-los para escolher implicitamente integração de outro tenant.
- **Fail closed nos efeitos**: conectar/testar = read-only. Dinheiro, mensagens outbound, writes CINEVISION e mudança de modo exigem sua capability, permissão, idempotência e condição operacional.
- **Não incorporar browsers remotos genéricos/SSRF**: URLs permitidas por provider; não aceitar URL arbitrária para fetch, DNS privado/metadata ou redirecionamento não autorizado; CINEVISION origin pin por conta e sessão isolada.
- **Não prometer CINEVISION write automático**: Cloudflare challenge/CAPTCHA/2FA/contrato de escrita não certificado → `HUMAN_REQUIRED`, sem bypass. Modo manual continua funcional.
- **Sem criar framework paralelo**: reutilizar `SecretsPort`, `provider.provider_accounts`, `billing.tenant_channels`, `communication.tenant_channels`, `MessagingGatewayPort`, `AsaasPort`, `ProviderOpsPort`, Inbox/Outbox, capability registry.

## 3. UX: /settings/integrations

Adicionar navegação 'Configurações > Integrações' ao shell existente. Cards: Asaas (Cobranças), WhatsApp (Atendimento), CINEVISION (Servidor/Ativação). Cada card exibe estado, ambiente, conta mascarada/número autorizado, última verificação, último webhook/evento, capabilities habilitadas e ações Conectar, Testar, Reautorizar, Configurar, Desconectar. Incluir onboarding guiado inicial e seção Problemas/Como resolver.

Estados acessíveis: loading, vazio, offline, permissão insuficiente, invalid credentials, test timeout, degraded, webhook pending, challenge/manual. Usuário sem permissão pode consultar status sanitizado conforme política; nunca revelar segredos salvos. Não mostrar 'Copiado!' quando clipboard falhou. Confirmar ações potencialmente disruptivas; disconnect pausa novos efeitos, mas NÃO apaga faturas/eventos/assinaturas ou evidências históricas.

Onboarding de tenant: (1) conta e equipe; (2) catálogo; (3) Asaas; (4) WhatsApp; (5) CINEVISION; (6) testes sem efeito; (7) go-live explícito. Pode pular uma integração e usar modo manual para as funcionalidades compatíveis; tela informa exatamente o que permanece indisponível.

## 4. Persistência e API (contratos propostos; ajustar aos contratos canônicos)

Usar ou estender entidades existentes em vez de duplicá-las. Uma nova tabela `platform.tenant_integrations` é aceitável SOMENTE após mapear o `provider.provider_accounts` e as tabelas de canais. Armazenar `tenant_id`, `provider`, `provider_account_id/channel_id`, `environment`, `connection_status`, `capability_status` (derivado, não duplicado), `secret_ref`, `webhook_ref`, `last_checked_at`, `last_error_code` (sem segredo), `version`, `created_by`, `updated_at`. Índices e uniqueness por (tenant, provider, account/environment), RLS e auditoria. Multi-conta por provider pode ficar pós-MVP, mas contrato não deve impedir expansão.

Endpoints candidatos, todos sob o tenant autenticado e política de permissão (confirmar naming com API existente):
- `GET /v1/integrations`, `GET /v1/integrations/:provider` — status e capability sanitizados, sem segredos.
- `POST /v1/integrations/:provider/configure` — criar/atualizar binding e gravar segredos no vault (nunca devolver), optimistic version/idempotency; separar criação de qualquer enablement.
- `POST /v1/integrations/:provider/test` — verificação read-only, bounded, resposta estruturada, nenhum efeito comercial.
- `POST /v1/integrations/:provider/activate` — somente se capability certificada + operator gate, versão esperada e revisão.
- `POST /v1/integrations/:provider/rotate` — troca segura de credenciais, canary read-only e rollback.
- `POST /v1/integrations/:provider/disable` — pausa novos efeitos; preservar histórico.
- `GET /v1/integrations/:provider/events` — histórico de saúde e últimas falhas, sanitizado.
- Endpoints de pairing WhatsApp separados: `POST /v1/integrations/whatsapp/session`, `GET /v1/integrations/whatsapp/session`, `GET /v1/integrations/whatsapp/qr`, `POST /v1/integrations/whatsapp/reconnect` (somente sessão do tenant; QR sem cache, validade curta).
- Endpoint de webhook management Asaas server-side conforme API oficial, sem entregar auth token ao browser.

Padronizar falhas com `code` como `INVALID_CREDENTIALS`, `PROVIDER_UNAVAILABLE`, `WEBHOOK_PENDING`, `REAUTH_REQUIRED`, `CHALLENGE_HUMAN_REQUIRED`, `CAPABILITY_UNCERTIFIED`, `TENANT_FORBIDDEN`, `CONFLICT`; mensagens amigáveis, detalhes seguros e retry orientado. Preservar convenções de erro já adotadas.

## 5. Asaas — wizard de conexão

1. Escolha Sandbox ou Produção (ambiente é explícito; host allowlist, sem URL editável).
2. Insira a API key em campo protegido. Backend grava em Infisical por tenant/ambiente; nunca GET/revela.
3. 'Testar conexão' usa API read-only autorizada e verifica identidade/escopo, sem criar cliente/cobrança.
4. Mostrar URL de webhook do tenant e opção 'Configurar automaticamente'. Criar/atualizar webhook via `POST /v3/webhooks` e consultar/listar estado. Gerar auth token distinto da API key, persistir no vault e sincronizar hash na tabela `billing.tenant_channels`, com rotação reversível. Tratar limite de webhooks sem duplicar configurações; oferecer modo copiar URL/configuração manual.
5. Testar entrega real/assinada e inbox dedupe em sandbox; somente então habilitar capability de cobranças permitida pelo gate.
6. Status: conta, Sandbox/Prod, cobrança habilitada ou não, webhook conectado/pendente, reconciliação e última confirmação. Teste sandbox controlado somente por ação explícita.

O Asaas documenta provisionamento via `POST /v3/webhooks`, `authToken` em `asaas-access-token`, limite de dez webhooks por conta. Não usar o segredo da API como token do webhook.

A resolução de adapter no runtime deve ser por tenant + conta, com rotação e binding estável. Não usar `ASAAS_ADAPTER=echo|real` global como seletor de tenant no produto self-service.

## 6. WhatsApp — wizard de QR via WAHA

1. Modo inicial: WAHA compartilhado e gerenciado pela plataforma, uma sessão isolada por tenant (BYO WAHA endpoint avançado/pós-MVP, se necessário). Credencial de administração do WAHA não pertence ao tenant e não vai ao navegador.
2. O backend provisiona `POST /api/sessions`, configura webhooks por sessão e guarda vínculo persistente `tenant↔session` e segredo/hash de webhook em `communication.tenant_channels`.
3. O painel exibe QR a partir de `GET /api/{session}/auth/qr` via proxy autenticado e por sessão; QR atualiza ao expirar; oferece código de pareamento somente se suportado no engine escolhido.
4. Exibir `STOPPED`, `STARTING`, `SCAN_QR_CODE`, `WORKING`, `FAILED`, `REAUTH_REQUIRED`, `CAPPED`, sem tratar restriction/timelock como desconexão genérica. Permitir reconectar, pausar outbound, enviar mensagem teste para número autorizado, consultar último inbound e validar dedupe.
5. Sessão persiste após restart. Revisar `waha-sessions.ts` que usa `Map` em memória e fallback `WAHA_SESSION=default`; em produção multi-tenant não pode haver fallback para sessão de outro tenant. Em caso de vínculo ausente, falhar fechado.
6. Nunca enviar sem autorização do tenant, opt-in e gate de comunicação. Não prometer WhatsApp Cloud API oficial; manter WAHA como engine inicial, futuro adapter Meta separado.

## 7. CINEVISION — wizard de conta e capacidades

1. Inserir URL de painel **allowlisted/pinned por conta**, usuário/senha ou método de autenticação suportado/permitido, com gravação server-side no Infisical. Nunca guardar token de sessão do browser no banco nem revelar no painel.
2. Criar `provider.provider_accounts` do tenant com `secret_ref`. Validar origem/versão, login e leitura de identidade, planos, clientes, servidores, saldo, através do Browser Worker já existente.
3. O Browser Worker hoje é single-binding por env; desenhar pool/job-scoped por tenant+providerAccountId com perfil/sessão isolados, serialização/concurrency budgets, limpeza e auditoria. Não reutilizar sessão/cookie/token entre tenants.
4. Ler capabilities individualmente. Exibir `CONNECTED_READ_ONLY` quando a conta autenticar e as leituras forem validadas; writes permanecem `UNCERTIFIED`/`HUMAN_REQUIRED` enquanto Step 3/6–9 não tiver evidências live.
5. Primeira importação de clientes existentes: preview, mapeamento de contas, conflitos, idempotência e confirmação humana. Ações de ativação/renovação seguem o `ProviderOperation` durável e postcondition gate existentes.
6. Quando challenge, CAPTCHA, 2FA, Cloudflare ou drift: mostrar instrução e deixar o operador concluir manualmente. Sem bypass de controles de acesso, nem inferir write contract a partir de bundle.

## 8. Segurança e governança proporcionais

Permissões específicas `integration.read`, `integration.manage`, `integration.test`, `integration.activate` ou reuso de permissões canônicas equivalentes; somente admin do tenant gerencia credenciais. Para produção financeira/rotacionar/desconectar, aviso de impacto e confirmação única. Zero credenciais em respostas; status e últimas quatro letras mascaradas somente quando não revelam informações sensíveis. Toda alteração auditada com tenant, user, provider, ação, revisão e resultado; sem valores.

Secret writer deve ser server-side: a implementação atual de `packages/secrets` é focada em resolução/leitura, então incluir port `put/rotate/revoke` ou serviço de provisioning separado com escopo mínimo, comportamento idempotente e teste; nunca fazer browser → Infisical direto. Resolver vault unavailable sem deixar integração falsa como CONNECTED. Tokens rotacionados podem manter overlap controlado até confirmar recepção e cutover.

## 9. Implementação incremental (PRs pequenos)

- **G0 (P0)**: restaurar CI HEAD `b3109a9`; execução #41123565284 falhou em 0 jobs. Diagnosticar workflow_dispatch/erro de definição e revalidar SHA antes de novas features.
- **S1 — Fundação**: modelo de integração tenant-scoped, schema, secret writer, API de status/config/test/disable, auditoria e estados; tests RLS/adversariais.
- **S2 — Asaas**: wizard Sandbox/prod, vault, API read-only probe, webhook auto-provision/rotate, runtime tenant-scoped, sandbox E2E.
- **S3 — WhatsApp**: WAHA session persistent por tenant, QR/pareamento/reativação, webhook por conta, health; restart/replay/tenant E2E.
- **S4 — CINEVISION**: conta/vault + read-only certification + session binding no Worker; UI de capacidades e fallback manual. Writes automáticos permanecem bloqueados até certificação.
- **S5 — Onboarding/UX**: hub, cards, guides, erros em pt-BR, health/events, documentação e browser E2E; habilitar por tenant/flag gradual.

## 10. Definition of Done por fatia

- Testes RED→GREEN: Zod contratos, RLS, tenant A/B, não vazamento, HTTP read-only, timeout/retry, webhook fake+live sandbox, reconcile, logout/restart, RBAC, status e UI browser.
- Com tenant A e B integrados ao mesmo WAHA, A nunca lê/sende/recebe sessão de B, mesmo após restart.
- Com duas contas Asaas, evento/pagamento de A nunca altera ledger/entitlement de B; webhook token distinto e idempotência.
- CINEVISION leitura não equivale a permissão de escrita; challenge mostra HUMAN_REQUIRED.
- Salvar/rotacionar credenciais não requer CLI, deploy ou edição de .env do usuário; segredos não retornam e write only via servidor.
- Sandbox é padrão para testes financeiros. Produção e efeitos externos somente mediante ato explícito, com auditoria.
- Tests + build + CI obrigatórios verde no mesmo SHA; PR revisado, rollout opt-in, rollback seguro.
- Não alterar P8/F12/G07 por conveniência, não promover capabilities sem evidência de operador.
