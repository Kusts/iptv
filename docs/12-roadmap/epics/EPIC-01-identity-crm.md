# EPIC-01 — Identity & CRM

## Outcome

Resolver uma pessoa de forma canônica entre canais e manter Lead/Customer sem duplicar identidade.

## Stories

### CRM-01 — Person + Identity resolution determinística

**Aceite:** WhatsApp/email/social identity conhecida resolve Person existente; nova identity cria Person quando policy permite; merge ambíguo não ocorre automaticamente.

### CRM-02 — Lead lifecycle

**Aceite:** Lead segue apenas transições canônicas; source attribution preservada; novo ciclo comercial pode coexistir historicamente para mesma Person.

### CRM-03 — Customer promotion/reactivation

**Aceite:** conversão cria/ativa Customer único por Person; reativação não duplica Customer.

### CRM-04 — Customer 360 query baseline

**Aceite:** API retorna Identity + Lead + Customer + Trial summary com escopo tenant.

### CRM-05 — Merge review

**Aceite:** casos ambíguos podem ser revisados, merged/unmerged com audit e sem perder histórico.

## Epic Gate

Person é autoridade de identidade; nenhuma feature posterior cria customer/contact paralelo sem passar por Identity/CRM.
