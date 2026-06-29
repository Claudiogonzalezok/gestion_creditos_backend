Estuve analizando el requerimiento de implementar venta de contado y antes de programar quiero que hagamos un análisis de arquitectura para elegir la solución de menor impacto, reutilizando al máximo lo que ya tiene el sistema.

Contexto funcional
La venta de contado debe seguir exactamente el mismo flujo de aprobación que una venta financiada.
Es decir:
el vendedor crea la operación,
queda en PENDING_APPROVAL,
el administrador la aprueba,
recién ahí se entrega el producto y se registra la operación.
No existe un flujo directo de venta. Todo pasa por aprobación.
Lo que necesito que analices

Quiero que primero determines cuál es la mejor alternativa desde el punto de vista de la arquitectura, priorizando:

reutilizar la mayor cantidad posible del código existente;
evitar duplicar lógica;
mantener una arquitectura limpia;
generar el menor impacto posible sobre el sistema.
Me gustaría que evalúes especialmente esto

Tengo dos posibles enfoques y quiero que determines cuál conviene.

Opción A

Mantener credits.type = SALE y agregar un discriminador (por ejemplo payment_condition, sale_mode o el nombre que consideres correcto) para distinguir entre:

venta financiada
venta contado
Opción B

Extender directamente credits.type y tener tres tipos de operación:

LOAN
SALE
CASH_SALE

De esa forma el propio tipo de operación determina el flujo.

Lo que quiero que determines

No quiero que implementes todavía.

Primero quiero que hagas un relevamiento completo del sistema y respondas:

¿Cuál de las dos alternativas tiene realmente menor impacto?
¿Cuál reutiliza mejor el código existente?
¿Cuál obliga a modificar menos lugares del sistema?
¿Cuál mantiene una arquitectura más limpia y más fácil de mantener a futuro?
¿Existe alguna tercera alternativa mejor que estas dos?
También quiero que revises

Analizá absolutamente todas las dependencias antes de decidir:

creación del crédito;
aprobación;
cuotas;
payments;
stock;
comisiones;
caja;
reportes;
dashboards;
filtros;
consultas;
validaciones;
frontend (wizard y aprobaciones).

Quiero asegurarme de que no aparezca ningún impacto oculto.

Importante

No quiero una implementación todavía.

Quiero primero un análisis técnico completo, bien fundamentado, con ventajas y desventajas de cada alternativa, y una recomendación final basada en el menor impacto posible y en reutilizar lo que ya existe.