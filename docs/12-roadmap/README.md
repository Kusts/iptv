# Roadmap — StreamMax V1 para operação própria

**Plano de execução atual:** [StreamMax V1 — produto unificado](../01-product/STREAMMAX-V1-PLANO-UNIFICADO.md).

Decisão de 16/11/2026: primeiro consolidar o StreamMax e a equipe IPTV do OpenMausBot em um produto funcional para clientes finais da operação própria. A etapa SaaS para operadores externos vem depois.

A sequência de entrega é **M0 auditoria e cortes → M1 atendimento/API/lead → M2 pedido/PIX → M3 ativação/suporte/renovação → M4 limpeza/homologação → M5 piloto de produção**. Cada marco precisa entregar comportamento funcional testado; não apenas documentação.

Os planos históricos v1.0 e suas Waves continuam preservados como referência técnica, mas **não determinam sozinhos a prioridade comercial da V1 atual**. Use o [baseline de implementação](../15-implementation-baseline/README.md) para contratos técnicos ainda válidos. Conflitos ou decisões antigas devem ser reconciliados via PR com código, testes e documentação afetados; não marcar funcionalidades como implementadas apenas porque constam em spec.

Não executar itens de SaaS, novos agentes, Hatchet, MK ou integrações opcionais como bloqueios do caminho V1 sem uma necessidade funcional comprovada. Não apagar migrations históricas ou dados operacionais durante a limpeza.
