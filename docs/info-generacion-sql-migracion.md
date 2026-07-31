# Explicación de las columnas de la planilla Excel para la importación

La planilla contiene información de créditos/préstamos ya existentes. A partir de ella hay que generar los datos necesarios para importar al sistema y crear los registros SQL correspondientes (crédito, cuotas y pagos).

## F. inicio

Es la **fecha de inicio de pagos**.

* Corresponde a la **fecha de vencimiento de la primera cuota**.
* A partir de esta fecha deben calcularse los vencimientos de todas las cuotas según el plan de pago.
* Si el cliente realizó un pago mayor al valor de una cuota en esa fecha, significa que pagó varias cuotas juntas. También puede interpretarse como un pago parcial que debe distribuirse entre las cuotas.

## F. entrega

Es la **fecha de entrega del producto** o **fecha en que se otorgó el préstamo**.

* Esta fecha solo debe utilizarse para calcular el cronograma de cuotas cuando **F. inicio esté vacía**.
* En ese caso, la primera cuota se considera con fecha **F. entrega**.

## Total

Es el **monto total a pagar**.

Incluye:

* Capital.
* Intereses.

Es el importe que debe cancelarse completamente al finalizar el crédito.

## Observación

En muchos registros este campo contiene el **capital prestado** o el **precio del producto**.

* Cuando exista ese dato, debe utilizarse como capital.
* Cuando esté vacío, por el momento asumir que el capital es igual al Total (es decir, sin poder separar intereses). Mañana confirmaré esta regla con el cliente.

## PLAN DE PAGO

Indica la frecuencia de las cuotas.

Puede aparecer como:

* Diaria
* Semanal
* Quincenal
* Mensual

En algunos casos, en lugar de decir "Semanal", aparece directamente un día de la semana (por ejemplo: Lunes, Martes, Miércoles, etc.). En esos casos debe interpretarse como un plan **semanal**.

## Ctas

Cantidad total de cuotas del crédito.

## IMP

Importe de cada cuota.

Generalmente coincide con:

```
Total / Cantidad de cuotas
```

## Pagado

Representa el dinero que el cliente fue abonando.

La planilla va acumulando los pagos realizados.

Para la importación:

1. Sumar todos los importes pagados.
2. Calcular cuántas cuotas completas cubre ese importe.
3. Si queda un saldo menor al valor de una cuota, debe registrarse como una cuota parcialmente pagada.

Ejemplo:

* Cuota: $100
* Total pagado: $250

Resultado:

* Cuota 1: Pagada.
* Cuota 2: Pagada.
* Cuota 3: Pago parcial de $50.

## Fecha

Es la fecha en la que el cliente realizó cada pago (completo o parcial).

Los pagos deben aplicarse respetando el orden cronológico de estas fechas.

## Generación de las cuotas

Las cuotas deben generarse calculando sus vencimientos a partir de:

1. **F. inicio**, si existe.
2. En caso contrario, **F. entrega**.

La periodicidad depende del Plan de Pago.

## Estado inicial de las cuotas

Al momento de importar:

* Toda cuota cuyo vencimiento sea anterior a la fecha actual debe quedar con estado **VENCIDA**, salvo que ya esté completamente pagada.
* Las cuotas totalmente cubiertas por los pagos deben quedar como **PAGADAS**.
* Si una cuota tiene solo una parte abonada, debe quedar **PARCIALMENTE PAGADA**.
* Las cuotas futuras deben quedar **PENDIENTES**.

avisame si necesitas un ejemplo. o si necesitas mas detalle en que filas y columnas se encuentra la informacion que te describo. o si no encontras alguna.