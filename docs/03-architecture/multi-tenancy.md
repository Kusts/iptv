# Multi-Tenancy Architecture

> Status: Draft auto-revisado  
> Versão: 1.0  
> Data: 2026-09-20

## 1. Objetivo

Permitir que a própria operação seja o primeiro tenant sem criar uma arquitetura single-tenant impossível de comercializar depois.

## 2. Modelo inicial recomendado

**Pooled application + pooled PostgreSQL com tenant isolation forte**.

Motivos:

- menor custo operacional inicial;
- facilita MVP e tenant piloto;
- mantém capacidade de escalar;
- permite oferecer isolamento dedicado no futuro se necessário.

## 3. Tenant Context

Toda request/job/event tenant-owned deve resolver explicitamente:

```text
tenant_id
user_id/actor
roles/permissions
feature entitlements
```

Nenhum “current tenant” global implícito compartilhado entre requests.

## 4. Database isolation

Camadas:

1. query/service filters obrigatórios;
2. Row-Level Security ou mecanismo equivalente;
3. testes de cross-tenant access;
4. privileged maintenance paths explicitamente separados.

## 5. Events / Jobs

Todo event/job tenant-owned carrega `tenant_id`.

Consumer precisa estabelecer tenant context antes de consultar estado.

## 6. Cache

Keys incluem tenant namespace.

Nunca:

```text
customer:123
```

Preferir:

```text
tenant:T1:customer:123
```

## 7. Object Storage

Objects tenant-owned são namespaced e authorization-aware.

## 8. Knowledge

Separar:

- tenant-private knowledge;
- platform/global knowledge compartilhável explicitamente;
- provider knowledge compartilhável conforme policy/licença.

Nenhum aprendizado de um tenant deve vazar automaticamente para outro.

## 9. Agent

Agent context deve receber apenas:

- tenant configuration permitida;
- Customer data do tenant;
- Knowledge autorizado;
- tools autorizadas.

## 10. Secrets

Credenciais externas são associadas ao tenant e acessíveis somente aos adapters autorizados.

## 11. Usage metering

Desde o tenant piloto medir:

- LLM usage;
- messages;
- browser time;
- storage;
- transcription;
- workflows;
- contacts;
- support volume.

Mesmo quando não houver billing SaaS ainda.

## 12. Future isolation options

Sem mudar domínio, futuros tiers podem adotar:

- database/schema dedicado;
- worker pool dedicado;
- browser pool dedicado;
- region dedicated.

Não é requisito do MVP.

## 13. Auto-revisão aplicada

Revisado para:

- evitar `tenant_id` como única defesa;
- proteger cache/storage/jobs/knowledge além do DB;
- separar private/shared knowledge;
- permitir isolamento dedicado futuro sem exigir agora.
