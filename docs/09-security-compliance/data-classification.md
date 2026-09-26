# Data Classification & Handling Standard

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20

## 1. Objetivo

Definir classes de sensibilidade e regras de manuseio para banco, eventos, logs, object storage, analytics, AI context e exports.

## 2. Classes

### C0 — Public

Pode ser publicamente divulgado.

Exemplos:

- preços públicos;
- conteúdo institucional aprovado;
- documentação pública;
- catálogo público quando aplicável.

### C1 — Internal

Informação operacional sem PII sensível, não destinada ao público.

Exemplos:

- métricas agregadas internas;
- feature flags não sensíveis;
- IDs internos sem contexto pessoal;
- status geral de jobs.

### C2 — Confidential

Dados pessoais/negócio que exigem controle de acesso.

Exemplos:

- nome;
- telefone;
- e-mail;
- handles sociais;
- conversas;
- customer notes;
- histórico de suporte;
- attribution individual;
- pedidos e preços individuais;
- device/app profile ligado a uma Person.

### C3 — Restricted

Dados cujo vazamento ou uso indevido pode causar impacto elevado.

Exemplos:

- secrets/API keys;
- browser session cookies/storage state;
- provider credentials;
- tokens OAuth;
- dados de autenticação;
- reset/MFA artifacts;
- informações financeiras de alto risco;
- raw traces contendo credenciais;
- documentos de identidade se futuramente coletados.

## 3. Dados que não devemos armazenar quando não necessários

Evitar persistência de:

- dados completos de cartão;
- CVV;
- password do cliente em logs/analytics;
- secrets dentro de Event payload;
- browser cookies em banco comum;
- conteúdo adulto/preferências sensíveis além do mínimo operacional necessário;
- geolocalização precisa sem necessidade clara.

Usar referências/tokens de providers quando possível.

## 4. Matriz de handling

| Controle | C0 | C1 | C2 | C3 |
|---|---:|---:|---:|---:|
| Auth necessária | não | sim | sim | sim |
| Tenant scope | n/a | sim | sim | sim |
| Encryption in transit | sim | sim | sim | sim |
| Encryption at rest | desejável | sim | sim | sim |
| Logs permitidos | sim | sim | redigidos | não/raw proibido |
| Analytics externo | sim | controlado | minimizado/pseudonimizado | proibido |
| AI context | sim | sim | somente necessário | nunca raw secret |
| Export pelo usuário | n/a | conforme role | auditado | extremamente restrito |
| Retention explícita | baixa | sim | sim | sim/curta |

## 5. Event payload policy

Domain events devem preferir IDs e fatos mínimos.

Evitar:

```json
{
  "phone": "+55...",
  "message_text": "...",
  "api_key": "..."
}
```

Preferir:

```json
{
  "person_id": "...",
  "conversation_id": "...",
  "outcome": "DELIVERED"
}
```

Consumidor autorizado busca detalhe na fonte canônica.

## 6. Logs e traces

Redaction obrigatória para:

- authorization headers;
- cookies;
- query strings sensíveis;
- request bodies com credentials;
- Asaas/Ads tokens;
- provider login/password;
- WhatsApp session artifacts.

Browser traces podem capturar C2/C3 e portanto:

- ficam em storage protegido;
- têm acesso limitado;
- possuem retention específica;
- não são enviados automaticamente para terceiros.

## 7. AI / LLM data minimization

Context Builder deve enviar apenas o necessário para a tarefa.

Exemplo de suporte:

necessário:

- device/app;
- problema;
- passos tentados;
- status da assinatura quando relevante.

normalmente desnecessário:

- histórico financeiro completo;
- outros contatos;
- secrets;
- informações de outro tenant.

## 8. Object Storage

Namespaces conceituais:

```text
/{tenant_id}/attachments/
/{tenant_id}/knowledge-sources/
/{tenant_id}/browser-traces/
/{tenant_id}/creative-assets/
```

A path não é autorização. Backend/policy deve validar acesso.

## 9. Analytics

### Regra

Métricas canônicas devem funcionar sem enviar PII desnecessária a ferramentas de terceiros.

Analytics IDs:

- tenant-scoped;
- pseudonymous quando possível;
- nunca secrets.

## 10. Backups

Backups herdam a classificação mais alta dos dados contidos.

Precisam:

- encryption;
- access controls;
- retention;
- restore test;
- deletion lifecycle coerente.

## 11. Auto-revisão aplicada

Revisado para:

- proteger traces/browser sessions explicitamente;
- minimizar PII em eventos e analytics;
- não sugerir armazenamento de payment card data;
- distinguir pseudonymization de anonimização;
- incluir AI context como superfície de vazamento.
