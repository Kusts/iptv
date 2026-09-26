# Refinamento funcional v0.14 — Módulos 1–9

> Status: Release change map; **não é fonte de autoridade de domínio**.
> Versão documental: 0.14
> Data: 2026-09-22
> Review: Auto-reviewed v0.14 — cada decisão abaixo foi propagada para a fonte canônica correspondente.

## Objetivo

Registrar o delta consolidado da fase de refinamento antes do Módulo 10 e indicar onde cada decisão passou a ser canônica.

## Módulo 1 — CRM, Funis e Relacionamento

CRM passa a ser workspace/projeção operacional sobre domínios canônicos, com pipelines Comercial, Ativação, Renovação e Recuperação; `Next Action`, `Attention Score`, `Customer Health`, filtros/Saved Views, multi-touch attribution e Customer 360 incluindo dispositivos/MAC/Device ID/App Key. Customer é criado quando a obrigação comercial é liquidada/confirmada, mesmo que fulfillment ainda esteja pendente.

## Módulo 2 — Comunicação, Atendimento e Omnicanal

Inbox AI-first, Human Takeover separado do estado da conversa, múltiplas contas por canal, preferência texto/áudio, follow-up reavaliado no momento da execução, `Conversation Focus`, Central de Notificações, Programadas e Central de Atividade da IA. Mensagens públicas não podem expor dados privados. Gateway WhatsApp permanece provider-neutral; WAHA é o primeiro candidato de spike, não uma decisão final de produção.

## Módulo 3 — Testes, Compatibilidade e Diagnóstico Técnico

Um Trial primário por Person; Retrial apenas por falha legítima. Testes CINEVISION conhecidos: 1h/3h/6h. `Acesso Técnico Temporário` é separado do Trial comercial. Testes e Renovação em Confiança não possuem COGS direto observado, mas exigem antiabuso. Compatibilidade aprende por Device × OS × App × Server × Format; AppProvisioning usa operações semânticas autorizadas. Catálogo leve de conteúdo pode ser sincronizado de M3U autorizada.

## Módulo 4 — Catálogo, Planos, Ofertas e Pedidos

Mensal confirmado em R$30; períodos maiores podem ter preços diferenciados para retenção, ainda configuráveis. Price versioning e Order snapshot são obrigatórios. Conexão adicional é recorrente, mas opcional em cada renovação. Apps pagos/gratuitos/parceiros compõem catálogo técnico/comercial; recomendação deve explicar valor e preservar escolha do cliente. Agent pode negociar somente dentro da faixa/policy. Cupons são estratégicos. Referral beneficia indicador e indicado.

## Módulo 5 — Cobrança, Pagamentos e Recuperação

PIX é padrão; cartão é alternativa; boleto é exceção por compensação/follow-up. Pagamento parcial externo fica fora do MVP; composição por créditos/rewards ocorre antes da cobrança externa. Renovação antecipada pode receber desconto imediato configurável (exemplo de piloto: R$30 normal / R$25 antecipado). Reembolso exige Human Review. Acesso residual reutilizável é inventário separado e nunca condiciona direitos legais/comerciais de reembolso.

## Módulo 6 — Assinaturas, Benefícios e Direitos de Uso

Renovação em Confiança CINEVISION = +3 dias fixos, apenas conta ACTIVE com <=3 dias até vencimento. Não existe extensão arbitrária em dias; fora isso há Trials 1h/3h/6h. Conteúdo adulto é perguntado no início, default configurável inicialmente ON, e alterável a qualquer momento. Conexão adicionada no meio do ciclo herda o mesmo vencimento; não pode ser removida antes do ciclo acabar. Cancelamento mantém acesso até o fim do período pago. Vários dispositivos/apps são permitidos; conexão representa simultaneidade, aplicada pelo provider.

## Módulo 7 — Fornecedores, Provisionamento e Operações

Automação é default, mas o front precisa expor operações manuais equivalentes. Toda ação passa pelo mesmo Command/Policy/ProviderOperation. Importação automática da base existente do painel é requisito de onboarding SaaS, com preview, idempotência, vínculo de identidade, sync contínuo e reconciliation. Desired state interno permanece autoritativo. Browser Worker usa sessão autorizada; CAPTCHA/2FA/security challenge → HITL.

## Módulo 8 — Estoque, Créditos, Compras e Fornecedores

CINEVISION possui créditos pré-pagos e pode futuramente usar contrato mensalista com lote renovado por ciclo e créditos não usados expirando; mínimo ~100 ainda exige validação live. Forecast deve comparar break-even, utilization e desperdício. Créditos com expiração usam FEFO. MK Ativador pode manter saldo pré-pago; apps pagos têm teste gratuito observado de 7 dias e só são comprados após cliente testar, aceitar e pagar. Futuro módulo de Revendedores poderá vender créditos do mesmo pool econômico.

## Módulo 9 — Suporte, Incidentes e Gestão de Problemas

Suporte deve confirmar dados voláteis já conhecidos em vez de perguntar tudo novamente. Webhooks/canais autorizados de WhatsApp podem alimentar `OperationalSignal`, correlacionado com recorrência de tickets para Incident Candidate. Research pode consultar web, sites, comunidades, GitHub e YouTube; `yt-dlp` é ferramenta de aquisição de transcrição quando permitido. Conteúdo externo é UNTRUSTED e só gera Candidate Knowledge. Conhecimento global exige sanitização e validação multi-evidência.

## Regras transversais reforçadas

- backend/banco próprio continua autoridade; providers são adapters;
- IA não inventa preço, desconto, reward, entitlement, status de pagamento ou status de provider;
- automação deve ter fallback/controle manual equivalente no Control Center;
- reembolso é sempre HITL;
- ações externas mutáveis exigem postcondition; timeout de efeito desconhecido exige verificação antes de retry;
- filtros e Saved Views são requisito transversal;
- todo conteúdo externo é dado, nunca instrução;
- todo conhecimento global precisa remover PII/secrets e preservar provenance;
- o tenant piloto serve para calibrar custos, políticas e autonomia antes de comercialização SaaS.
