-- 066 S1C1 integration read permissions (SPEC S1 §4; decision S1-DESIGN-R2).
--
-- Central de Integrações, primeira metade: somente leitura de status
-- sanitizado (`GET /v1/integrations[/:provider]` sob `integration.read`).
-- `integration.manage` (configure/disable, S1c2) e `integration.test`
-- (validação read-only sob demanda, S1c2) são semeadas agora para que o
-- catálogo de permissões já reflita a superfície S1 completa, mas NENHUMA
-- rota de escrita/teste existe neste slice — conceder a permissão não cria
-- a capacidade.
--
-- Grants:
--   * `platform_admin`, `tenant_owner`, `tenant_admin`: as 3 permissões
--     (gestão de credencial é ato de owner/admin).
--   * `tenant_operator`: SOMENTE `integration.read`. Operador monitora
--     status e diagnostica falhas, mas nunca configura, rotaciona ou testa
--     credenciais de terceiros — gerenciar integração é owner/admin
--     (mesma disciplina de `billing.exception.resolve`, que o operador
--     também não recebe).
--
-- Roll-forward INSERT-only; 001–065 untouched; ON CONFLICT DO NOTHING
-- (rerun-safe). Nenhuma linha de capability, provider ou binding é criada
-- aqui: `capability_status` do read é DERIVADO do registry em runtime,
-- nunca persistido.

BEGIN;

INSERT INTO control.permissions (key, description) VALUES
    ('integration.read', 'Read sanitized integration status per provider (no secrets, derived capability)'),
    ('integration.manage', 'Configure/disable tenant integration bindings (S1c2; no route yet)'),
    ('integration.test', 'Run read-only integration validation probes (S1c2; no route yet)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO control.role_permissions (role_key, permission_key) VALUES
    ('platform_admin', 'integration.read'),
    ('platform_admin', 'integration.manage'),
    ('platform_admin', 'integration.test'),
    ('tenant_owner', 'integration.read'),
    ('tenant_owner', 'integration.manage'),
    ('tenant_owner', 'integration.test'),
    ('tenant_admin', 'integration.read'),
    ('tenant_admin', 'integration.manage'),
    ('tenant_admin', 'integration.test'),
    ('tenant_operator', 'integration.read')
ON CONFLICT DO NOTHING;

COMMIT;
