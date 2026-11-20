import type { Kysely } from "kysely";
import { withTenantTransaction, type Database } from "@iptv/database";

/**
 * Projeção sanitizada e compartilhada da leitura de fulfillment — usada tanto
 * por `GET /v1/fulfillment/subscriptions/:id` (operador humano) quanto por
 * `POST /v1/bot/streammax/get-fulfillment` (bot de serviço, somente leitura).
 *
 * Nunca seleciona `requested_payload_json`, `result_summary_json`,
 * `secret_ref`, `correlation_id`, `idempotency_key`, evidência do provider,
 * `external_ref` ou `trace_ref`. O tenant vem sempre do contexto autenticado,
 * nunca do corpo, e a leitura roda dentro da transação do tenant (RLS).
 */
export type FulfillmentStatusView = {
  subscriptionId: string;
  operationId: string;
  action: string;
  status: string;
  effectCertainty: string;
  requestedAt: string;
  subscriptionStatus: string | null;
};

/**
 * `null` significa "nenhuma operação de fulfillment para esta assinatura neste
 * tenant" — inclui id inexistente ou pertencente a outro tenant, que falha
 * fechado como NOT_FOUND em ambos os callers (sem vazamento de existência).
 */
export async function readFulfillmentStatus(
  db: Kysely<Database>,
  tenantId: string,
  subscriptionId: string,
): Promise<FulfillmentStatusView | null> {
  return withTenantTransaction(db, tenantId, async (trx) => {
    const operation = await trx
      .selectFrom("provider.provider_operations")
      .select(["id", "action", "status", "effect_certainty", "requested_at"])
      .where("tenant_id", "=", tenantId)
      .where("entity_type", "=", "subscription")
      .where("entity_id", "=", subscriptionId)
      .orderBy("requested_at", "desc")
      .executeTakeFirst();
    if (operation === undefined) {
      return null;
    }
    const subscription = await trx
      .selectFrom("subscription.subscriptions")
      .select("status")
      .where("tenant_id", "=", tenantId)
      .where("id", "=", subscriptionId)
      .executeTakeFirst();
    return {
      subscriptionId,
      operationId: operation.id,
      action: operation.action,
      status: operation.status,
      effectCertainty: operation.effect_certainty,
      requestedAt: operation.requested_at.toISOString(),
      subscriptionStatus: subscription?.status ?? null,
    };
  });
}
