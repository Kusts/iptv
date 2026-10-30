-- 064 F16 same-customer ownership (docs/15-implementation-baseline/14-e2e-acceptance-matrix.md
-- row F16; invariant in docs/15-implementation-baseline/20-data-model-blueprint.md:196).
--
-- Tenant-only FKs accept valid IDs from two customers of the same tenant mixed across
-- Order/Subscription/Cycle/Entitlement/add-on charge. This migration adds the
-- database-level same-customer enforcement.
--
-- Owner model (learned from the live run): commerce.orders.customer_id is NULLABLE
-- and normal quote/settlement leaves it NULL; the actual buyer identity is
-- orders.person_id, with crm.customers unique on (tenant_id, person_id) and
-- subscription.customer_id referencing crm.customers.id. The invariant is therefore:
--
--   owner(o) = crm.customers.id for (o.tenant_id, o.person_id), and every
--   subscription<->order link (originating order, renewal order, add-on charge
--   order item) requires owner(order) = subscription.customer_id. Cross-person IDs
--   from two customers of one tenant fail; a NULL orders.customer_id is normal and
--   passes whenever the person-derived owner matches. A NON-NULL orders.customer_id
--   must additionally equal the person-derived owner (internal consistency); a linked
--   order breaching that is rejected at link time, at parent-change time, and in
--   preflight. Unlinked orders are left alone so unrelated history never blocks this
--   migration: inconsistency there is caught if the order is ever linked.
--
-- Child side (INSERT + UPDATE of the link-bearing columns):
--   1. subscription.originating_order_id names an order whose person-derived owner
--      is the subscription's customer (trigger; no composite FK: there is no stored
--      owner column on orders that a FK could reference);
--   2. subscription_cycles.renewal_order_id names an order whose person-derived owner
--      is the cycle's subscription customer (trigger); moving a cycle to another
--      subscription also revalidates its renewal link and every add-on charge already
--      posted against the cycle;
--   3. entitlement.entitlements rows with source_type = 'subscription' carry the SAME
--      customer as the referenced subscription (trigger: polymorphic source link);
--   4. subscription.subscription_addon_cycle_charges rows require the cycle and the
--      add-on link to belong to the SAME subscription (hence same customer) and, when
--      order_item_id is set, the item's order to have the subscription's customer as
--      person-derived owner (trigger: multi-hop join). No item_type restriction:
--      base-plan items legitimately back charges
--      (see apps/api/test/f16-cross-customer.integration.test.ts).
--
-- Parent side (UPDATE only; an INSERT cannot break a relationship that does not
-- reference it yet). Each rejects the update only when an existing relationship
-- would become inconsistent:
--   5. commerce.orders.person_id / customer_id: originating subscriptions, renewal
--      cycles pointing at the order, and add-on charges whose order item belongs to
--      the order keep their person-derived owner (person_id moves are guarded, not
--      just the nullable customer_id);
--   6. subscription.subscriptions.customer_id: originating/renewal-order links,
--      subscription-sourced entitlements, and the order-item leg of linked add-on
--      charges keep their owner;
--   7. subscription.subscription_cycles.subscription_id: the renewal link and all
--      linked add-on charges stay consistent with the new subscription;
--   8. subscription.subscription_addons.subscription_id: linked add-on charges stay
--      on one subscription with a same-owner order item;
--   9. commerce.order_items.order_id: linked add-on charges keep a same-owner item.
--   10. crm.customers.person_id: moving a customer row to another person may not
--      silently reassign the person-derived owner of linked orders. Because
--      (tenant_id, person_id) is unique, every order currently owned by this row
--      is found via OLD.person_id, so guarding the old row is sufficient; moves
--      with no currently valid linked edge stay allowed (no repair, legacy
--      preserved).
--
-- Concurrency: every check reads a column only from a row it already holds
-- FOR SHARE (which conflicts with the row lock a concurrent parent UPDATE must
-- take), so validation never runs on a half-moved parent. Parent keys are never
-- trusted from an unlocked read: link rows (cycles, add-ons, items) are locked
-- first, keys are derived from the locked rows, value parents (subscriptions,
-- orders, person-derived customer rows) are locked next, and only then are the
-- validated columns read. Checkers take no other lock mode, and FOR SHARE never
-- conflicts with itself, so checkers cannot deadlock against each other regardless
-- of acquisition order; waits between a checker and a parent writer are one-way
-- (the writer's triggers take no conflicting row locks). Any residual deadlock
-- (e.g. with DDL) aborts the statement with an error: fail-closed, never a bypass.
-- Parent-side triggers use plain reads except where they lock the single NEW parent
-- row (and the owner customer row via the helper); a concurrent child writer blocks
-- on the parent's own row lock and revalidates against the committed parent
-- afterwards.
--
-- Preflight: the migration aborts (RAISE EXCEPTION, full rollback) when existing rows
-- already violate any invariant. It never repairs or deletes data; the operator must
-- reconcile first.
--
-- Deliberately NOT in this migration:
--   * No change to 001-063 (append-only).
--   * No new columns, no RLS/GRANT changes, no BYPASSRLS, no GRANT to PUBLIC.

BEGIN;

-- Owner helper: derive an order's owner customer (crm.customers.id via the order's
-- (tenant_id, person_id)), locking the order row and the owner row FOR SHARE.
-- Raises when a NON-NULL orders.customer_id disagrees with the person-derived owner.
-- o_order_found=false means the order row is missing (caller defers to the FK);
-- o_owner_customer_id=NULL with found=true means no customer row exists for the
-- buyer's person (callers treat that as fail-closed: it can never equal a
-- subscription's non-null customer_id).
CREATE OR REPLACE FUNCTION commerce.lock_order_owner_customer(
    p_tenant_id uuid,
    p_order_id uuid,
    OUT o_order_found boolean,
    OUT o_owner_customer_id uuid
)
RETURNS record
LANGUAGE plpgsql
AS $$
DECLARE
    v_person_id uuid;
    v_stored_customer_id uuid;
BEGIN
    o_order_found := false;
    o_owner_customer_id := NULL;

    SELECT o.person_id, o.customer_id INTO v_person_id, v_stored_customer_id
    FROM commerce.orders o
    WHERE o.tenant_id = p_tenant_id
      AND o.id = p_order_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN;
    END IF;
    o_order_found := true;

    SELECT cu.id INTO o_owner_customer_id
    FROM crm.customers cu
    WHERE cu.tenant_id = p_tenant_id
      AND cu.person_id = v_person_id
    FOR SHARE;

    IF v_stored_customer_id IS NOT NULL
       AND v_stored_customer_id IS DISTINCT FROM o_owner_customer_id THEN
        RAISE EXCEPTION 'F16: order % stores customer_id % inconsistent with its person-derived owner %',
            p_order_id, v_stored_customer_id, o_owner_customer_id;
    END IF;
    RETURN;
END;
$$;

-- Preflight: abort when existing data already mixes customers within one tenant.
DO $$
DECLARE
    v_bad_origin integer;
    v_bad_renewal integer;
    v_bad_entitlement integer;
    v_bad_charge_link integer;
    v_bad_charge_item integer;
BEGIN
    SELECT count(*) INTO v_bad_origin
    FROM subscription.subscriptions s
    JOIN commerce.orders o
      ON o.tenant_id = s.tenant_id
     AND o.id = s.originating_order_id
    LEFT JOIN crm.customers cu
      ON cu.tenant_id = o.tenant_id
     AND cu.person_id = o.person_id
    WHERE s.originating_order_id IS NOT NULL
      AND (cu.id IS DISTINCT FROM s.customer_id
           OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id));

    SELECT count(*) INTO v_bad_renewal
    FROM subscription.subscription_cycles c
    JOIN subscription.subscriptions s
      ON s.tenant_id = c.tenant_id
     AND s.id = c.subscription_id
    JOIN commerce.orders o
      ON o.tenant_id = c.tenant_id
     AND o.id = c.renewal_order_id
    LEFT JOIN crm.customers cu
      ON cu.tenant_id = o.tenant_id
     AND cu.person_id = o.person_id
    WHERE c.renewal_order_id IS NOT NULL
      AND (cu.id IS DISTINCT FROM s.customer_id
           OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id));

    SELECT count(*) INTO v_bad_entitlement
    FROM entitlement.entitlements e
    JOIN subscription.subscriptions s
      ON s.tenant_id = e.tenant_id
     AND s.id = e.source_id
    WHERE e.source_type = 'subscription'
      AND e.customer_id IS DISTINCT FROM s.customer_id;

    SELECT count(*) INTO v_bad_charge_link
    FROM subscription.subscription_addon_cycle_charges ch
    JOIN subscription.subscription_cycles c
      ON c.tenant_id = ch.tenant_id
     AND c.id = ch.subscription_cycle_id
    JOIN subscription.subscription_addons a
      ON a.tenant_id = ch.tenant_id
     AND a.id = ch.subscription_addon_id
    WHERE c.subscription_id IS DISTINCT FROM a.subscription_id;

    SELECT count(*) INTO v_bad_charge_item
    FROM subscription.subscription_addon_cycle_charges ch
    JOIN subscription.subscription_cycles c
      ON c.tenant_id = ch.tenant_id
     AND c.id = ch.subscription_cycle_id
    JOIN subscription.subscriptions s
      ON s.tenant_id = c.tenant_id
     AND s.id = c.subscription_id
    JOIN commerce.order_items oi
      ON oi.tenant_id = ch.tenant_id
     AND oi.id = ch.order_item_id
    JOIN commerce.orders o
      ON o.tenant_id = oi.tenant_id
     AND o.id = oi.order_id
    LEFT JOIN crm.customers cu
      ON cu.tenant_id = o.tenant_id
     AND cu.person_id = o.person_id
    WHERE ch.order_item_id IS NOT NULL
      AND (cu.id IS DISTINCT FROM s.customer_id
           OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id));

    IF v_bad_origin + v_bad_renewal + v_bad_entitlement + v_bad_charge_link + v_bad_charge_item > 0 THEN
        RAISE EXCEPTION 'migration 064 preflight: same-customer violations present (originating_order=%, renewal_order=%, entitlement=%, charge_link=%, charge_item=%); reconcile data before installing F16 guards',
            v_bad_origin, v_bad_renewal, v_bad_entitlement, v_bad_charge_link, v_bad_charge_item;
    END IF;
END;
$$;

-- (1) Subscription originating order: the order's person-derived owner must be the
-- subscription's customer. No composite FK is possible (owner is join-derived, and
-- orders.customer_id is nullable decoration), so a trigger enforces it on the
-- referencing side; the parent-side orders trigger (5) protects the referenced side.
CREATE OR REPLACE FUNCTION subscription.assert_originating_order_same_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_found boolean;
    v_owner uuid;
BEGIN
    IF NEW.originating_order_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT h.o_order_found, h.o_owner_customer_id INTO v_found, v_owner
    FROM commerce.lock_order_owner_customer(NEW.tenant_id, NEW.originating_order_id) AS h;
    IF NOT v_found THEN
        RETURN NEW;
    END IF;

    IF v_owner IS DISTINCT FROM NEW.customer_id THEN
        RAISE EXCEPTION 'F16: originating order % belongs to another customer than subscription %',
            NEW.originating_order_id, NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_originating_same_owner
BEFORE INSERT OR UPDATE OF tenant_id, customer_id, originating_order_id
ON subscription.subscriptions
FOR EACH ROW EXECUTE FUNCTION subscription.assert_originating_order_same_owner();

-- (2) Cycle renewal order: person-derived owner must be the cycle's subscription
-- customer. Also revalidates linked add-on charges when a cycle moves (7).
CREATE OR REPLACE FUNCTION subscription.assert_cycle_renewal_same_customer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_sub_customer uuid;
    v_found boolean;
    v_owner uuid;
BEGIN
    IF NEW.renewal_order_id IS NULL
       AND (TG_OP = 'INSERT' OR NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id) THEN
        RETURN NEW;
    END IF;

    SELECT s.customer_id INTO v_sub_customer
    FROM subscription.subscriptions s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.id = NEW.subscription_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.renewal_order_id IS NOT NULL THEN
        SELECT h.o_order_found, h.o_owner_customer_id INTO v_found, v_owner
        FROM commerce.lock_order_owner_customer(NEW.tenant_id, NEW.renewal_order_id) AS h;
        IF NOT v_found THEN
            RETURN NEW;
        END IF;

        IF v_owner IS DISTINCT FROM v_sub_customer THEN
            RAISE EXCEPTION 'F16: renewal order % belongs to another customer than subscription % (cycle %)',
                NEW.renewal_order_id, NEW.subscription_id, NEW.id;
        END IF;
    END IF;

    -- (7) A cycle that moves subscriptions must not strand its charges: every
    -- linked charge must resolve to the new subscription with a same-owner item.
    IF TG_OP = 'UPDATE' AND NEW.subscription_id IS DISTINCT FROM OLD.subscription_id THEN
        IF EXISTS (
            SELECT 1
            FROM subscription.subscription_addon_cycle_charges ch
            JOIN subscription.subscription_addons a
              ON a.tenant_id = ch.tenant_id
             AND a.id = ch.subscription_addon_id
            WHERE ch.tenant_id = NEW.tenant_id
              AND ch.subscription_cycle_id = NEW.id
              AND a.subscription_id IS DISTINCT FROM NEW.subscription_id
        ) THEN
            RAISE EXCEPTION 'F16: moving cycle % to subscription % strands add-on charges of another subscription',
                NEW.id, NEW.subscription_id;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM subscription.subscription_addon_cycle_charges ch
            JOIN commerce.order_items oi
              ON oi.tenant_id = ch.tenant_id
             AND oi.id = ch.order_item_id
            JOIN commerce.orders o
              ON o.tenant_id = oi.tenant_id
             AND o.id = oi.order_id
            LEFT JOIN crm.customers cu
              ON cu.tenant_id = o.tenant_id
             AND cu.person_id = o.person_id
            WHERE ch.tenant_id = NEW.tenant_id
              AND ch.subscription_cycle_id = NEW.id
              AND ch.order_item_id IS NOT NULL
              AND (cu.id IS DISTINCT FROM v_sub_customer
                   OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id))
        ) THEN
            RAISE EXCEPTION 'F16: moving cycle % to subscription % strands add-on charges backed by another customer''s order item',
                NEW.id, NEW.subscription_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_cycles_renewal_same_customer
BEFORE INSERT OR UPDATE OF tenant_id, subscription_id, renewal_order_id
ON subscription.subscription_cycles
FOR EACH ROW EXECUTE FUNCTION subscription.assert_cycle_renewal_same_customer();

-- (3) Subscription-sourced entitlement: same customer as the source subscription.
CREATE OR REPLACE FUNCTION entitlement.assert_subscription_source_same_customer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_sub_customer uuid;
BEGIN
    IF NEW.source_type IS DISTINCT FROM 'subscription' THEN
        RETURN NEW;
    END IF;

    SELECT s.customer_id INTO v_sub_customer
    FROM subscription.subscriptions s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.id = NEW.source_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.customer_id IS DISTINCT FROM v_sub_customer THEN
        RAISE EXCEPTION 'F16: entitlement % carries another customer than its source subscription %',
            NEW.id, NEW.source_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER entitlements_subscription_source_same_customer
BEFORE INSERT OR UPDATE OF tenant_id, customer_id, source_type, source_id
ON entitlement.entitlements
FOR EACH ROW EXECUTE FUNCTION entitlement.assert_subscription_source_same_customer();

-- (4) Add-on cycle charge: cycle and add-on link share one subscription; the order
-- item's order (when set) has the subscription's customer as person-derived owner.
-- Lock discipline: lock the link rows FIRST (cycle, add-on, item), derive parent
-- keys from the locked rows, lock the value parents (subscription, order + owner),
-- and only then read the validated columns. Missing parents defer to the FKs.
CREATE OR REPLACE FUNCTION subscription.assert_addon_charge_same_customer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_cycle_sub uuid;
    v_addon_sub uuid;
    v_sub_customer uuid;
    v_item_order uuid;
    v_found boolean;
    v_owner uuid;
BEGIN
    PERFORM 1
    FROM subscription.subscription_cycles c
    WHERE c.tenant_id = NEW.tenant_id
      AND c.id = NEW.subscription_cycle_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM subscription.subscription_addons a
    WHERE a.tenant_id = NEW.tenant_id
      AND a.id = NEW.subscription_addon_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF NEW.order_item_id IS NOT NULL THEN
        PERFORM 1
        FROM commerce.order_items oi
        WHERE oi.tenant_id = NEW.tenant_id
          AND oi.id = NEW.order_item_id
        FOR SHARE;
        IF NOT FOUND THEN
            RETURN NEW;
        END IF;
    END IF;

    SELECT c.subscription_id INTO v_cycle_sub
    FROM subscription.subscription_cycles c
    WHERE c.tenant_id = NEW.tenant_id
      AND c.id = NEW.subscription_cycle_id;

    SELECT a.subscription_id INTO v_addon_sub
    FROM subscription.subscription_addons a
    WHERE a.tenant_id = NEW.tenant_id
      AND a.id = NEW.subscription_addon_id;

    IF v_cycle_sub IS DISTINCT FROM v_addon_sub THEN
        RAISE EXCEPTION 'F16: add-on charge % mixes cycle % of subscription % with add-on link % of subscription %',
            NEW.id, NEW.subscription_cycle_id, v_cycle_sub, NEW.subscription_addon_id, v_addon_sub;
    END IF;

    IF NEW.order_item_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.customer_id INTO v_sub_customer
    FROM subscription.subscriptions s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.id = v_cycle_sub
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT oi.order_id INTO v_item_order
    FROM commerce.order_items oi
    WHERE oi.tenant_id = NEW.tenant_id
      AND oi.id = NEW.order_item_id;

    SELECT h.o_order_found, h.o_owner_customer_id INTO v_found, v_owner
    FROM commerce.lock_order_owner_customer(NEW.tenant_id, v_item_order) AS h;
    IF NOT v_found THEN
        RETURN NEW;
    END IF;

    IF v_owner IS DISTINCT FROM v_sub_customer THEN
        RAISE EXCEPTION 'F16: add-on charge % order item % belongs to another customer than subscription %',
            NEW.id, NEW.order_item_id, v_cycle_sub;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER addon_cycle_charges_same_customer
BEFORE INSERT OR UPDATE OF tenant_id, subscription_cycle_id, subscription_addon_id, order_item_id
ON subscription.subscription_addon_cycle_charges
FOR EACH ROW EXECUTE FUNCTION subscription.assert_addon_charge_same_customer();

-- (5) Parent side: an order's buyer (person_id) or stored customer_id may change
-- only while no originating subscription, renewal cycle, or add-on charge item
-- still ties the order to another person-derived owner.
CREATE OR REPLACE FUNCTION commerce.assert_order_customer_change_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_owner uuid;
BEGIN
    IF NEW.person_id IS NOT DISTINCT FROM OLD.person_id
       AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
        RETURN NEW;
    END IF;

    -- Resolve the PROPOSED owner from NEW.person_id under lock. The generic
    -- helper cannot be used here: in a BEFORE UPDATE trigger it would read the
    -- still-stored OLD person_id and validate the reparent against the wrong
    -- owner. Lock the candidate owner row FOR SHARE so a concurrent customer
    -- insert/delete/reparent serializes against this check.
    SELECT cu.id INTO v_owner
    FROM crm.customers cu
    WHERE cu.tenant_id = NEW.tenant_id
      AND cu.person_id = NEW.person_id
    FOR SHARE;
    -- No row -> v_owner stays NULL: fail-closed below, since NULL can never
    -- equal a linked subscription's non-null customer_id.

    IF NEW.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM v_owner THEN
        RAISE EXCEPTION 'F16: order % stores customer_id % inconsistent with its proposed person-derived owner %',
            NEW.id, NEW.customer_id, v_owner;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscriptions s
        WHERE s.tenant_id = NEW.tenant_id
          AND s.originating_order_id = NEW.id
          AND s.customer_id IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'F16: order % owner change breaks an originating link of another customer', NEW.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_cycles c
        JOIN subscription.subscriptions s
          ON s.tenant_id = c.tenant_id
         AND s.id = c.subscription_id
        WHERE c.tenant_id = NEW.tenant_id
          AND c.renewal_order_id = NEW.id
          AND s.customer_id IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'F16: order % owner change breaks a renewal link of another customer', NEW.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_addon_cycle_charges ch
        JOIN commerce.order_items oi
          ON oi.tenant_id = ch.tenant_id
         AND oi.id = ch.order_item_id
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = ch.tenant_id
         AND c.id = ch.subscription_cycle_id
        JOIN subscription.subscriptions s
          ON s.tenant_id = c.tenant_id
         AND s.id = c.subscription_id
        WHERE oi.tenant_id = NEW.tenant_id
          AND oi.order_id = NEW.id
          AND s.customer_id IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'F16: order % owner change breaks an add-on charge link of another customer', NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER orders_customer_change_same_customer
BEFORE UPDATE OF person_id, customer_id
ON commerce.orders
FOR EACH ROW EXECUTE FUNCTION commerce.assert_order_customer_change_safe();

-- (6) Parent side: a subscription's customer may change only while no originating/
-- renewal order link, subscription-sourced entitlement, or charge item still ties
-- it to another person-derived owner.
CREATE OR REPLACE FUNCTION subscription.assert_subscription_customer_change_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscriptions s
        JOIN commerce.orders o
          ON o.tenant_id = s.tenant_id
         AND o.id = s.originating_order_id
        LEFT JOIN crm.customers cu
          ON cu.tenant_id = o.tenant_id
         AND cu.person_id = o.person_id
        WHERE s.tenant_id = NEW.tenant_id
          AND s.id = NEW.id
          AND s.originating_order_id IS NOT NULL
          AND (cu.id IS DISTINCT FROM NEW.customer_id
               OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id))
    ) THEN
        RAISE EXCEPTION 'F16: subscription % customer change breaks an originating order link of another customer', NEW.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_cycles c
        JOIN commerce.orders o
          ON o.tenant_id = c.tenant_id
         AND o.id = c.renewal_order_id
        LEFT JOIN crm.customers cu
          ON cu.tenant_id = o.tenant_id
         AND cu.person_id = o.person_id
        WHERE c.tenant_id = NEW.tenant_id
          AND c.subscription_id = NEW.id
          AND c.renewal_order_id IS NOT NULL
          AND (cu.id IS DISTINCT FROM NEW.customer_id
               OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id))
    ) THEN
        RAISE EXCEPTION 'F16: subscription % customer change breaks a renewal order link of another customer', NEW.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM entitlement.entitlements e
        WHERE e.tenant_id = NEW.tenant_id
          AND e.source_type = 'subscription'
          AND e.source_id = NEW.id
          AND e.customer_id IS DISTINCT FROM NEW.customer_id
    ) THEN
        RAISE EXCEPTION 'F16: subscription % customer change strands a subscription-sourced entitlement of another customer', NEW.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_addon_cycle_charges ch
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = ch.tenant_id
         AND c.id = ch.subscription_cycle_id
        JOIN commerce.order_items oi
          ON oi.tenant_id = ch.tenant_id
         AND oi.id = ch.order_item_id
        JOIN commerce.orders o
          ON o.tenant_id = oi.tenant_id
         AND o.id = oi.order_id
        LEFT JOIN crm.customers cu
          ON cu.tenant_id = o.tenant_id
         AND cu.person_id = o.person_id
        WHERE c.tenant_id = NEW.tenant_id
          AND c.subscription_id = NEW.id
          AND ch.order_item_id IS NOT NULL
          AND (cu.id IS DISTINCT FROM NEW.customer_id
               OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id))
    ) THEN
        RAISE EXCEPTION 'F16: subscription % customer change breaks an add-on charge item link of another customer', NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_customer_change_same_customer
BEFORE UPDATE OF customer_id
ON subscription.subscriptions
FOR EACH ROW EXECUTE FUNCTION subscription.assert_subscription_customer_change_safe();

-- (8) Parent side: an add-on link may move subscriptions only while its charges
-- stay on one subscription with a same-owner order item.
CREATE OR REPLACE FUNCTION subscription.assert_addon_subscription_move_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_customer uuid;
BEGIN
    IF NEW.subscription_id IS NOT DISTINCT FROM OLD.subscription_id THEN
        RETURN NEW;
    END IF;

    SELECT s.customer_id INTO v_new_customer
    FROM subscription.subscriptions s
    WHERE s.tenant_id = NEW.tenant_id
      AND s.id = NEW.subscription_id
    FOR SHARE;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_addon_cycle_charges ch
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = ch.tenant_id
         AND c.id = ch.subscription_cycle_id
        WHERE ch.tenant_id = NEW.tenant_id
          AND ch.subscription_addon_id = NEW.id
          AND c.subscription_id IS DISTINCT FROM NEW.subscription_id
    ) THEN
        RAISE EXCEPTION 'F16: moving add-on link % to subscription % strands charges posted against another subscription',
            NEW.id, NEW.subscription_id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_addon_cycle_charges ch
        JOIN commerce.order_items oi
          ON oi.tenant_id = ch.tenant_id
         AND oi.id = ch.order_item_id
        JOIN commerce.orders o
          ON o.tenant_id = oi.tenant_id
         AND o.id = oi.order_id
        LEFT JOIN crm.customers cu
          ON cu.tenant_id = o.tenant_id
         AND cu.person_id = o.person_id
        WHERE ch.tenant_id = NEW.tenant_id
          AND ch.subscription_addon_id = NEW.id
          AND ch.order_item_id IS NOT NULL
          AND (cu.id IS DISTINCT FROM v_new_customer
               OR (o.customer_id IS NOT NULL AND o.customer_id IS DISTINCT FROM cu.id))
    ) THEN
        RAISE EXCEPTION 'F16: moving add-on link % to subscription % strands charges backed by another customer''s order item',
            NEW.id, NEW.subscription_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_addons_subscription_move_same_customer
BEFORE UPDATE OF subscription_id
ON subscription.subscription_addons
FOR EACH ROW EXECUTE FUNCTION subscription.assert_addon_subscription_move_safe();

-- (9) Parent side: an order item may move orders only while its charges keep a
-- same-owner order.
CREATE OR REPLACE FUNCTION commerce.assert_order_item_move_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_found boolean;
    v_owner uuid;
BEGIN
    IF NEW.order_id IS NOT DISTINCT FROM OLD.order_id THEN
        RETURN NEW;
    END IF;

    SELECT h.o_order_found, h.o_owner_customer_id INTO v_found, v_owner
    FROM commerce.lock_order_owner_customer(NEW.tenant_id, NEW.order_id) AS h;
    IF NOT v_found THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM subscription.subscription_addon_cycle_charges ch
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = ch.tenant_id
         AND c.id = ch.subscription_cycle_id
        JOIN subscription.subscriptions s
          ON s.tenant_id = c.tenant_id
         AND s.id = c.subscription_id
        WHERE ch.tenant_id = NEW.tenant_id
          AND ch.order_item_id = NEW.id
          AND s.customer_id IS DISTINCT FROM v_owner
    ) THEN
        RAISE EXCEPTION 'F16: moving order item % to order % breaks an add-on charge link of another customer',
            NEW.id, NEW.order_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_order_move_same_customer
BEFORE UPDATE OF order_id
ON commerce.order_items
FOR EACH ROW EXECUTE FUNCTION commerce.assert_order_item_move_safe();

-- (10) Parent side: a customer row's person may change only while no currently
-- valid linked edge depends on it. Every order owned by this row is reachable via
-- OLD.person_id (uniqueness of (tenant_id, person_id)); only edges whose
-- subscription still names this customer are protected, so unrelated history and
-- already-broken edges never block the move and no data is repaired.
CREATE OR REPLACE FUNCTION crm.assert_customer_person_move_safe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.person_id IS NOT DISTINCT FROM OLD.person_id THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM commerce.orders o
        JOIN subscription.subscriptions s
          ON s.tenant_id = o.tenant_id
        WHERE o.tenant_id = NEW.tenant_id
          AND o.person_id = OLD.person_id
          AND s.originating_order_id = o.id
          AND s.customer_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'F16: moving customer % to another person breaks an originating link that names it', OLD.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM commerce.orders o
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = o.tenant_id
         AND c.renewal_order_id = o.id
        JOIN subscription.subscriptions s
          ON s.tenant_id = c.tenant_id
         AND s.id = c.subscription_id
        WHERE o.tenant_id = NEW.tenant_id
          AND o.person_id = OLD.person_id
          AND s.customer_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'F16: moving customer % to another person breaks a renewal link that names it', OLD.id;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM commerce.orders o
        JOIN commerce.order_items oi
          ON oi.tenant_id = o.tenant_id
         AND oi.order_id = o.id
        JOIN subscription.subscription_addon_cycle_charges ch
          ON ch.tenant_id = oi.tenant_id
         AND ch.order_item_id = oi.id
        JOIN subscription.subscription_cycles c
          ON c.tenant_id = ch.tenant_id
         AND c.id = ch.subscription_cycle_id
        JOIN subscription.subscriptions s
          ON s.tenant_id = c.tenant_id
         AND s.id = c.subscription_id
        WHERE o.tenant_id = NEW.tenant_id
          AND o.person_id = OLD.person_id
          AND s.customer_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'F16: moving customer % to another person breaks an add-on charge link that names it', OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER customers_person_move_same_customer
BEFORE UPDATE OF person_id
ON crm.customers
FOR EACH ROW EXECUTE FUNCTION crm.assert_customer_person_move_safe();

COMMIT;
