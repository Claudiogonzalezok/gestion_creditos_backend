# Contexto del Proyecto — Sistema de Gestión de Préstamos y Créditos

## Descripción general
Sistema web de gestión de préstamos personales y ventas a crédito, desarrollado para un cliente.  
Cuenta con dos portales separados: uno administrativo/operativo y uno para clientes.

## Stack tecnológico
- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL
- **Autenticación:** JWT (JSON Web Tokens)
- **Arquitectura:** MVC (Model, View, Controller)

## Actores / Roles del sistema
| Rol | Descripción |
|---|---|
| **Admin** | Control total del sistema. Único rol habilitado para recuperación de contraseñas y aprobación de operaciones. |
| **Vendor (Vendedor)** | Registra ventas a crédito y préstamos. |
| **Collector (Cobrador)** | Gestiona el cobro de cuotas e installments. |
| **Client (Cliente)** | Accede a su portal personal para consultar su estado de cuenta. |

## Portales
1. **Portal Administrativo/Operativo** — para Admin, Vendor y Collector
2. **Portal Cliente** — acceso exclusivo para clientes

Ambos portales usan autenticación JWT independiente.

## Reglas de negocio importantes
- La recuperación de contraseñas es **exclusiva del Admin** — ningún otro rol puede autogestionarla.
- Los pagos requieren **doble validación** (flujo de aprobación) antes de confirmarse.
- El Admin es el único que puede aprobar ciertas operaciones sensibles.

## Módulos principales
- Gestión de préstamos personales
- Ventas a crédito (cuotas / installments)
- Cobranza y seguimiento de pagos
- Administración de clientes
- Reportes y estado de cuenta

## Casos de uso
El sistema tiene 16 casos de uso formalmente documentados, cubriendo el ciclo completo:
alta de cliente → solicitud de crédito/préstamo → aprobación → generación de cuotas → cobranza → cierre.

## Modelo de datos
16 entidades principales (ER diagram documentado). Las entidades clave incluyen:
clientes, préstamos, ventas, cuotas, pagos, usuarios, roles, entre otras.

## Convenciones de código
- Arquitectura MVC estricta: separar rutas, controladores, modelos y middlewares.
- Los controladores no deben contener lógica de negocio compleja — usar servicios o helpers si aplica.
- Validaciones de entrada en el middleware, no en los controladores.
- Manejo centralizado de errores con middleware global.
- Variables de entorno en `.env` — nunca hardcodear credenciales.
- Comentarios en **español**.

## Estructura de carpetas esperada
```
GESTION_CREDITOS_BACKEND/
│    src/
│    ├── jobs/
│    ├── modules/                        # para definir la logica de los modulos del sistema
│    ├── middlewares/si
│    │   ├── auth.middleware.js          # Verificación JWT
│    │   └── validate.middleware.js      # Control de acceso por rol
│    ├── utils/
│    ├── config/
│    │   └── db.js                       # Conexión PostgreSQL
│    ├── app.js
│
├── .env
├── logs/    
```

## Lo que NO hacer
- No mezclar lógica de negocio en las rutas.
- No permitir que roles distintos de Admin accedan a recuperación de contraseñas.
- No aprobar pagos sin pasar por el flujo de doble validación.
- No exponer datos sensibles del cliente en respuestas de API innecesariamente.
-------------------------------------------------------------------------------------

 

DOCUMENTACIÓN DE CASOS DE USO 

Sistema Integral de Gestión de Préstamos Personales 

y Ventas de Productos a Crédito 

Versión 1.0  ·  01/04/2026  ·  Equipo de Desarrollo 

 

 

 

 

Índice de casos de uso 

CU01  Autenticar usuario  [Todos] 

CU02  Gestionar usuarios y roles  [Admin] 

CU03  Gestionar clientes  [Admin / Vendedor] 

CU04  Gestionar productos  [Admin / Vendedor] 

CU05  Generar pre-venta / pre-préstamo  [Vendedor / Admin] 

CU06  Ver estado de cuenta de clientes  [Admin / Vendedor / Cobrador] 

CU07  Registrar pre-carga de cobro  [Cobrador / Admin] 

CU08  Aprobar o rechazar pre-ventas y pre-préstamos  [Admin] 

CU09  Aprobar o rechazar pre-cargas de cobro  [Admin] 

CU10  Simular crédito / cotizador  [Cliente / Vendedor / Admin] 

CU11  Ver estado de cuenta propio  [Cliente] 

CU12  Gestionar caja y reportes  [Admin] 

CU13  Aplicar mora y cancelación anticipada  [Admin] 

CU14  Generar planilla de cobro  [Admin / Cobrador] 

CU15  Gestionar liquidaciones y comisiones  [Admin / Cobrador/vendedor] 

CU16  Configuracion de parametros del sistema  [Admin] 

 

 

 

 

Diagrama de casos de uso 

El siguiente diagrama muestra la relación entre los actores del sistema y los catorce casos de uso identificados, organizados por portal de acceso (público e interno). 

 

 

 

CU01 — Autenticar usuario 

Actores 

Actor principal: Cualquier usuario del sistema (Admin, Vendedor, Cobrador o Cliente según el portal) 

Actor de soporte: Admin / Dueño (único responsable de resetear contraseñas y desbloquear cuentas; no hay recuperación automática por email) 

Precondiciones 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

El usuario debe estar registrado y activo en el sistema. 

Para usuarios internos (Admin, Vendedor, Cobrador): acceder desde la URL del sistema interno. 

Para el Cliente: acceder desde la URL del portal público. 

El Admin debe haber comunicado las credenciales iniciales al usuario antes de su primer acceso. 

Flujo principal — Inicio de sesión exitoso (usuarios internos) 

El usuario accede a la URL del sistema interno desde cualquier dispositivo. 

El sistema presenta la pantalla de login con los campos: DNI y contraseña. 

El usuario ingresa sus credenciales y confirma. 

El sistema valida que el DNI exista, que el usuario esté activo y que la contraseña coincida con el hash almacenado. 

El sistema verifica que el usuario no esté bloqueado por intentos fallidos. 

El sistema genera un token JWT firmado con los siguientes datos: 

Identificador del usuario. 

Rol asignado: ADMIN, SELLER o COLLECTOR. 

Audiencia: sistema-interno. 

Tiempo de expiración: 8 horas desde la emisión. 

El sistema registra la fecha y hora del último acceso exitoso. 

El sistema redirige al usuario al dashboard correspondiente a su rol: 

ADMIN → panel de aprobaciones y caja. 

SELLER → módulo de nueva operación y clientes. 

COLLECTOR → módulo de cobros y planilla del día. 

Flujo principal — Inicio de sesión exitoso (Cliente en portal público) 

El Cliente accede a la URL del portal público. 

El sistema presenta la pantalla de inicio con dos opciones: Cotizador (sin login) y Mi cuenta (con login). 

El Cliente selecciona Mi cuenta e ingresa sus credenciales: DNI y contraseña. 

El sistema valida que el DNI exista, que el cliente esté activo y que la contraseña coincida. 

El sistema verifica que el cliente no esté bloqueado por intentos fallidos. 

El sistema genera un token JWT firmado con: Identificador del cliente, Rol: CLIENT, Audiencia: portal-cliente, Expiración: 30 minutos de inactividad. 

El sistema registra la fecha y hora del último acceso exitoso. 

El sistema redirige al Cliente al panel de su estado de cuenta. 

Flujo alternativo — Primer acceso con contraseña temporal 

El usuario ingresa las credenciales temporales comunicadas por el Admin. 

El sistema valida las credenciales pero detecta que es una contraseña temporal sin cambiar. 

El sistema redirige obligatoriamente a la pantalla de cambio de contraseña antes de mostrar cualquier módulo. 

El sistema informa: "Por seguridad, debés cambiar tu contraseña antes de continuar. Esta acción es obligatoria y no puede omitirse". 

El usuario ingresa la nueva contraseña y su confirmación. 

El sistema valida: mínimo 8 caracteres, al menos un número, no puede ser igual a la contraseña temporal. 

El sistema hashea la nueva contraseña, la persiste y marca la cuenta como contraseña propia establecida. 

El sistema genera el token JWT y redirige al dashboard correspondiente. 

Flujos alternativos 

A — Credenciales incorrectas 

El sistema muestra: "Credenciales incorrectas. Verificá tus datos e intentá nuevamente". 

El sistema no especifica cuál campo es incorrecto (medida de seguridad). 

El contador de intentos fallidos se incrementa y se resetea automáticamente tras un acceso exitoso. 

B — Bloqueo por intentos fallidos 

Tras tres intentos fallidos consecutivos, la cuenta queda bloqueada. 

El sistema muestra: "Tu cuenta fue bloqueada por seguridad. Comunicarte con el administrador del sistema para reactivarla". 

El bloqueo no se levanta automáticamente; requiere intervención del Admin. 

El Admin recibe notificación de bloqueo con fecha, hora y cantidad de intentos. 

C — Usuario solicita reseteo de contraseña al Admin 

El usuario debe comunicarse directamente con el Admin (presencial o por teléfono). 

No existe ningún mecanismo automático; el sistema no envía emails. 

El Admin verifica la identidad del solicitante antes de ejecutar el reseteo. 

D — Admin resetea contraseña de un usuario 

El Admin accede al módulo de Gestionar usuarios y permisos. 

El Admin selecciona el usuario y elige Resetear contraseña. 

El sistema genera una contraseña temporal alfanumérica de 8 caracteres. 

El sistema muestra la contraseña temporal una única vez en pantalla para que el Admin la comunique al usuario. 

El sistema hashea y almacena la contraseña marcándola como pendiente de cambio obligatorio. 

Si la cuenta estaba bloqueada, el reseteo la desbloquea automáticamente. 

E — Admin desbloquea cuenta sin resetear contraseña 

El Admin accede al módulo de usuarios, selecciona el usuario bloqueado y elige Desbloquear cuenta. 

El sistema resetea el contador de intentos fallidos a cero y reactiva el acceso sin modificar la contraseña. 

F — Cambio de contraseña voluntario 

Un usuario autenticado puede cambiar su contraseña desde su perfil en cualquier momento. 

El sistema solicita la contraseña actual como verificación antes de permitir el cambio. 

La nueva contraseña debe cumplir los requisitos mínimos y no puede ser igual a la actual. 

G — Cierre de sesión manual 

El sistema invalida el token JWT actual del lado del servidor. 

Si el usuario tenía trabajo no guardado, el sistema advierte antes de ejecutar el cierre. 

H — Sesión expirada 

Usuarios internos: el token expira a las 8 horas de emisión. 

Cliente: el token expira tras 30 minutos de inactividad. 

El sistema redirige al login con el mensaje: "Tu sesión expiró. Ingresá nuevamente". 

I — Cambio de rol con sesión activa 

El sistema invalida inmediatamente el token JWT del usuario afectado. 

Al volver a iniciar sesión, el usuario opera con su nuevo rol y permisos. 

J — Usuario inactivo intenta iniciar sesión 

Para usuarios internos: "Tu cuenta no está activa. Comunicarte con el administrador del sistema". 

Para el Cliente: "Tu cuenta no está disponible. Comunicarte con el negocio para más información". 

Postcondiciones 

Si exitoso: 

El usuario tiene un token JWT válido que lo identifica y autoriza durante el tiempo configurado. 

La fecha y hora del último acceso queda registrada en el perfil del usuario. 

El usuario accede únicamente a los módulos habilitados para su rol. 

Si fallido: 

No se genera ningún token. 

El contador de intentos fallidos se incrementa. 

Si llega a tres intentos, la cuenta queda bloqueada hasta intervención del Admin. 

Reglas de negocio relevantes 

Regla 

Descripción 

Sin recuperación automática 

No existe ningún mecanismo de reseteo sin intervención del Admin; elimina la necesidad de servidor de email 

Contraseña temporal visible una sola vez 

El sistema la muestra en pantalla al Admin únicamente en el momento de generarla 

Bloqueo manual 

El desbloqueo siempre requiere acción del Admin; no se levanta solo con el tiempo 

Tres intentos antes del bloqueo 

Aplica tanto para sistema interno como para portal de clientes 

Contraseña temporal obliga cambio 

Ningún usuario puede operar con una contraseña temporal; el cambio es obligatorio e impostergable 

JWT con audiencias separadas 

El token del sistema interno y el del portal público son incompatibles entre sí 

Contraseñas hasheadas 

El sistema nunca almacena contraseñas en texto plano (bcrypt con salt) 

Rol en el token 

El JWT lleva el rol del usuario; el backend valida el rol en cada endpoint sin consultar la BD en cada request 

Invalidación total ante cambio de rol 

Al cambiar el rol se invalidan todos los tokens activos del usuario en todos los dispositivos 

Admin como único soporte de acceso 

Toda gestión de credenciales pasa por el Admin; no hay autoservicio salvo el cambio voluntario de contraseña 

Diferencia entre los dos portales de acceso 

Aspecto 

Sistema interno 

Portal público (cliente) 

Identificador de login 

DNI 

DNI 

Roles posibles 

ADMIN, SELLER, COLLECTOR 

CLIENT 

Audiencia JWT 

sistema-interno 

portal-cliente 

Expiración del token 

8 horas fijas 

30 minutos de inactividad 

Módulos accesibles 

Según rol 

Solo estado de cuenta propio 

Bloqueo por intentos 

3 intentos 

3 intentos 

Reseteo de contraseña 

Admin del sistema 

Admin del sistema 

 

CU02 — Gestionar usuarios y roles 

Actores 

Actor principal: Admin / Dueño (único rol con acceso total a este módulo) 

No hay actores secundarios — ningún otro rol puede ver ni operar este módulo. 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

Debe existir al menos un Admin registrado en el sistema (el sistema no permite quedar sin ningún Admin activo). 

Flujo principal — Crear nuevo usuario 

El Admin accede al módulo de Usuarios y Permisos. 

El sistema muestra el listado de usuarios activos con DNI, nombre, email, rol, dirección y estado. 

El Admin selecciona "Nuevo usuario". 

El sistema presenta el formulario con los campos: DNI, nombre completo, email, dirección, contraseña temporal y rol (ADMIN, SELLER o COLLECTOR). 

El Admin completa los datos y confirma. 

El sistema valida que el DNI no esté duplicado. 

El sistema crea el usuario con estado ACTIVO, hashea la contraseña y registra la fecha de creación. 

El nuevo usuario recibe sus credenciales y puede iniciar sesión con la contraseña temporal, que el sistema solicitará cambiar en el primer acceso. 

Flujos alternativos 

A — Editar datos de un usuario 

En el paso 2, el Admin selecciona un usuario del listado. 

El sistema muestra la ficha con DNI, nombre, email, rol, dirección y estado actual. 

El Admin puede modificar todos los datos. 

El sistema registra la fecha y autor del último cambio. 

B — Cambiar rol de un usuario 

El Admin selecciona un usuario y elige un nuevo rol desde el selector. 

El sistema valida que el cambio no deje al sistema sin ningún Admin activo. 

Si el usuario tiene sesión iniciada, el sistema invalida su token JWT actual y lo fuerza a re-autenticarse con el nuevo rol. 

El cambio de rol tiene efecto inmediato sobre los permisos de acceso a módulos. 

C — Resetear contraseña 

El Admin selecciona un usuario y elige "Resetear contraseña". 

El sistema genera una contraseña temporal y la asocia al usuario. 

El usuario deberá cambiarla obligatoriamente en su próximo inicio de sesión. 

El sistema muestra la contraseña al Admin. El Admin la comunica manualmente. 

D — Desactivar usuario 

El Admin selecciona un usuario activo y elige "Desactivar". 

El sistema valida que no sea el único Admin activo del sistema. 

Si es el único Admin, bloquea la operación y muestra: "No es posible desactivar el único administrador activo del sistema". 

Si pasa la validación, el sistema cambia el estado a INACTIVO e invalida todos sus tokens JWT activos de forma inmediata. 

El usuario desactivado no puede iniciar sesión pero sus registros históricos (cobros, ventas) se conservan intactos con su referencia. 

E — Reactivar usuario 

El Admin puede reactivar un usuario INACTIVO desde el filtro de usuarios desactivados. 

El sistema cambia el estado a ACTIVO y habilita el acceso nuevamente. 

El usuario deberá iniciar sesión normalmente; sus permisos anteriores se restauran según su rol. 

F — DNI duplicado (error) 

En el paso 6 del flujo principal, si el DNI ya existe en el sistema, se muestra: "Ya existe un usuario registrado con ese DNI" y no se persiste el registro. 

Postcondiciones 

El usuario creado puede autenticarse y acceder únicamente a los módulos habilitados para su rol. 

Si fue desactivado, no puede iniciar sesión pero su historial de operaciones permanece disponible para auditoría. 

Todo cambio sobre usuarios queda registrado con fecha, hora y el Admin que lo ejecutó. 

Reglas de negocio relevantes 

Regla 

Descripción 

Mínimo un Admin activo 

El sistema bloquea cualquier operación que deje el sistema sin un Admin habilitado 

Baja lógica 

Los usuarios nunca se eliminan físicamente; solo se desactivan 

Rol inmutable en sesión activa 

Al cambiar el rol, el token JWT se invalida y se fuerza re-autenticación 

Contraseña hasheada 

El sistema nunca almacena contraseñas en texto plano (bcrypt o similar) 

DNI como identificador 

El DNI es único e irrepetible en el sistema 

Auditoría de cambios 

Toda modificación sobre usuarios registra quién la hizo y cuándo 

Matriz de permisos por módulo 

Módulo 

Admin 

Vendedor 

Cobrador 

Cliente 

Gestionar usuarios 

✓ 

— 

— 

— 

Gestionar clientes 

✓ 

✓ lectura/alta 

— 

— 

Gestionar productos 

✓ 

✓ lectura 

— 

— 

Generar pre-venta/préstamo 

✓ 

✓ 

— 

— 

Registrar cobro en calle 

✓ 

— 

✓ 

— 

Ver cuenta de clientes 

✓ 

✓ 

✓ 

— 

Aprobar/rechazar operaciones 

✓ 

— 

— 

— 

Caja y reportes 

✓ 

— 

— 

— 

Portal público / cotizador 

✓ 

✓ 

✓ 

✓ 

Ver estado de cuenta propio 

— 

— 

— 

✓ 

 

CU03 — Gestionar clientes 

Actores 

Actor principal: Admin / Dueño 

Actor secundario: Vendedor (puede registrar y consultar, pero no eliminar) 

Precondiciones 

El usuario debe estar autenticado con rol Admin o Vendedor. 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

Flujo principal — Registrar nuevo cliente 

El actor accede al módulo de Clientes. 

El sistema muestra el listado de clientes existentes con búsqueda y paginación. 

El actor selecciona "Nuevo cliente". 

El sistema presenta el formulario de alta con los campos requeridos: nombre completo, DNI, domicilio, teléfono, y opcionalmente email. 

El actor completa los datos y confirma. 

El sistema valida que el DNI no esté duplicado. 

El sistema persiste el nuevo cliente con estado ACTIVO y retorna la ficha creada. 

Flujos alternativos 

A — Editar cliente existente 

El actor selecciona un cliente de la lista. 

El sistema muestra la ficha con sus datos actuales y el historial de créditos asociados. 

El actor modifica los campos habilitados (no se puede cambiar el DNI) y confirma. 

El sistema actualiza el registro y registra la fecha de última modificación. 

B — Dar de baja / desactivar cliente 

Solo disponible para Admin. 

El sistema valida que el cliente no tenga créditos activos antes de permitir la baja. 

Si tiene créditos pendientes, el sistema bloquea la baja y muestra un mensaje de advertencia. 

Si no tiene deuda activa, el sistema cambia el estado a INACTIVO (baja lógica, no se elimina el registro). 

C — Buscar cliente 

El actor ingresa DNI, nombre o teléfono en el buscador. 

El sistema filtra en tiempo real y muestra los resultados coincidentes. 

Desde el resultado, el actor puede acceder a la ficha completa. 

D — DNI duplicado (error) 

Si el DNI ya existe, el sistema muestra: "Ya existe un cliente registrado con ese DNI" y no persiste el registro. 

Postcondiciones 

El cliente queda registrado y disponible para ser asociado a futuros créditos. 

Si fue desactivado, no aparece en los listados de nuevas operaciones, pero sí en el historial. 

Reglas de negocio relevantes 

Regla 

Descripción 

Baja lógica 

No se puede eliminar un cliente físicamente, solo desactivar (integridad referencial con la tabla de créditos) 

DNI como identificador único 

El DNI actúa como identificador único de negocio 

Cliente con deuda activa 

Un cliente con deuda activa no puede darse de baja hasta saldar 

Permisos del Vendedor 

El Vendedor puede crear y consultar clientes, pero no desactivarlos 

 

CU04 — Gestionar productos 

Actores 

Actor principal: Admin / Dueño 

Actor secundario: Vendedor (solo puede consultar el catálogo y el stock disponible, no modificar) 

Precondiciones 

El usuario debe estar autenticado con rol Admin o Vendedor. 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

Flujo principal — Registrar nuevo producto 

El actor accede al módulo de Productos. 

El sistema muestra el catálogo completo con nombre, precio actual y stock disponible, con búsqueda y paginación. 

El actor selecciona "Nuevo producto". 

El sistema presenta el formulario de alta con los campos: nombre, descripción (opcional), precio actual y stock inicial. 

El actor completa los datos y confirma. 

El sistema valida que el nombre no esté duplicado y que el precio y stock sean valores positivos. 

El sistema persiste el producto con estado ACTIVO y retorna la ficha creada. 

Flujos alternativos 

A — Editar producto existente 

El actor selecciona un producto del catálogo. 

El actor puede modificar nombre, descripción y precio actual. 

Al confirmar un cambio de precio, el sistema guarda el nuevo valor como current_price pero preserva el precio histórico en los créditos ya generados (historical_price en CREDIT_PRODUCT). 

B — Ajustar stock manualmente 

Solo disponible para Admin. 

El actor puede registrar una entrada o salida de stock indicando cantidad y motivo (reposición, pérdida, devolución). 

El sistema actualiza el campo available_stock y registra el movimiento con fecha y usuario. 

C — Dar de baja / desactivar producto 

Solo disponible para Admin. 

El sistema valida que el producto no esté asociado a créditos activos con cuotas pendientes. 

Si no tiene dependencias activas, cambia el estado a INACTIVO y lo oculta del catálogo de nuevas ventas, conservando el historial. 

D — Stock insuficiente al generar venta 

Este flujo se dispara desde el módulo de Ventas, no desde Gestionar Productos. 

Si available_stock = 0 o la cantidad solicitada supera el disponible, el sistema muestra una alerta y bloquea la operación. 

Postcondiciones 

El producto queda disponible en el catálogo para ser asociado a nuevas ventas a crédito. 

Los cambios de precio no afectan retroactivamente los créditos ya aprobados. 

Reglas de negocio relevantes 

Regla 

Descripción 

Precio histórico 

Cada ítem de crédito guarda el precio al momento de la venta (historical_price), independiente del precio actual 

Baja lógica 

No se elimina físicamente ningún producto, solo se desactiva 

Control de stock 

El stock se descuenta automáticamente al aprobar el crédito, no al generarlo como pre-venta 

Precio positivo 

El sistema no permite registrar un producto con precio cero o negativo 

Vendedor de solo lectura 

El Vendedor consulta el catálogo pero solo el Admin puede crear, editar o desactivar productos 

 

CU05 — Generar pre-venta / pre-préstamo 

Actores 

Actor principal: Vendedor 

Actor secundario: Admin / Dueño (puede ejecutar este caso de uso con los mismos permisos que el Vendedor) 

Precondiciones 

El usuario debe estar autenticado con rol Vendedor o Admin. 

Debe existir al menos un cliente registrado y activo en el sistema. 

Debe existir al menos un producto activo con stock disponible (para pre-ventas). 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

Flujo principal — Generar pre-venta (venta de producto a crédito) 

El Vendedor accede al módulo de Nueva Operación. 

El sistema presenta las opciones: Pre-venta (producto a crédito) o Pre-préstamo (dinero en efectivo). 

El Vendedor selecciona Pre-venta. 

El sistema solicita la búsqueda del cliente por DNI o nombre. 

El Vendedor ingresa el criterio y selecciona el cliente de los resultados. 

El sistema muestra la ficha del cliente con su historial crediticio resumido. 

El Vendedor agrega uno o más productos desde el catálogo, indicando cantidad por ítem. 

Por cada producto agregado, el sistema valida el stock disponible y registra el historical_price vigente al momento de la operación. 

El sistema calcula el monto total y presenta el simulador de cuotas; el Vendedor selecciona la cantidad de cuotas y el sistema muestra el monto por cuota con los intereses aplicados. 

El Vendedor confirma la operación. 

El sistema persiste el crédito con estado PENDING_APPROVAL y la relación CREDIT_PRODUCT con precio histórico, sin descontar stock aún. 

El sistema retorna el ID de la pre-venta generada y notifica al Admin que hay una operación pendiente de aprobación. 

Flujo principal — Generar pre-préstamo (efectivo) 

Pasos 1 y 2 igual al flujo anterior; el Vendedor selecciona Pre-préstamo. 

El sistema solicita la búsqueda del cliente. 

El Vendedor ingresa el monto total del préstamo en efectivo. 

El sistema presenta el simulador de cuotas; el Vendedor selecciona la cantidad de cuotas y visualiza el monto con intereses. 

El Vendedor confirma la operación. 

El sistema persiste el crédito de tipo LOAN con estado PENDING_APPROVAL. 

El sistema retorna el ID del pre-préstamo y notifica al Admin. 

Flujos alternativos 

A — Cliente no encontrado 

El sistema muestra: "No se encontró ningún cliente con ese criterio". 

El Vendedor puede registrar un nuevo cliente desde este mismo flujo y luego retomar la operación. 

B — Cliente con deuda en mora 

El sistema muestra una alerta visible: "Este cliente tiene cuotas vencidas". 

El sistema no bloquea la operación automáticamente; es decisión del Admin aprobar o rechazar. 

C — Stock insuficiente 

El sistema muestra: "Stock insuficiente. Disponible: X unidades" y no agrega el ítem al carrito. 

D — Cancelar operación en curso 

El Vendedor puede cancelar en cualquier momento antes de confirmar. No se persiste ningún registro ni se afecta el stock. 

Postcondiciones 

El crédito queda registrado con estado PENDING_APPROVAL a la espera de la decisión del Admin. 

Si el usuario que registra la operación es Admin, el crédito puede quedar directamente en estado ACTIVE. 

El stock no se descuenta en esta etapa; el descuento ocurre únicamente al aprobar el crédito. 

El precio de cada producto queda fijado con el valor vigente al momento de generar la pre-venta (historical_price). 

Reglas de negocio relevantes 

Regla 

Descripción 

Precio histórico 

El precio del producto se congela al generar la pre-venta, no al aprobarla 

Stock no reservado 

El stock no se bloquea ni descuenta hasta la aprobación del Admin 

Estado inicial 

Todo crédito nace en PENDING_APPROVAL, nunca directamente en ACTIVE (salvo que lo genere el Admin) 

Dos tipos de crédito 

SALE para venta de productos, LOAN para préstamo en efectivo 

Cuotas calculadas por el sistema 

El Vendedor elige cantidad de cuotas; el sistema calcula monto y genera el cronograma al aprobar 

Cliente inactivo bloqueado 

Si el cliente fue desactivado, el sistema impide generar cualquier operación a su nombre 

 

CU06 — Ver estado de cuenta de clientes 

Actores 

Actor principal: Admin / Dueño 

Actores secundarios: Vendedor y Cobrador (acceso de solo lectura, con información acotada según su rol) 

Precondiciones 

El usuario debe estar autenticado con rol Admin, Vendedor o Cobrador. 

Debe existir al menos un cliente registrado en el sistema. 

Flujo principal — Consultar cuenta de un cliente 

El actor accede al módulo de Clientes. 

El sistema muestra el listado de clientes activos con nombre, DNI, teléfono e indicador visual de estado crediticio (al día / con mora). 

El actor busca al cliente por DNI, nombre o teléfono. 

El sistema retorna los resultados coincidentes. 

El actor selecciona el cliente deseado. 

El sistema muestra la ficha completa con tres secciones: 

Sección 1 — Datos personales: Nombre completo, DNI, domicilio, teléfono, email y estado del cliente. 

Sección 2 — Resumen crediticio: Total adeudado, cuotas al día/en mora/pagas, indicador de riesgo (Verde/Amarillo/Rojo). 

Sección 3 — Detalle de créditos: Listado con tipo, monto, fechas, cuotas y estado. Al expandir cada crédito se muestra el cronograma completo de cuotas con estado y cobrador. 

Flujos alternativos 

A — Cliente no encontrado 

El sistema muestra: "No se encontró ningún cliente con ese criterio de búsqueda". 

B — Cliente sin créditos 

La Sección 3 muestra: "Este cliente no tiene operaciones registradas". Las secciones 1 y 2 se muestran con montos en cero. 

C — Filtrar por estado de cuota 

El actor puede filtrar por estado: todas, solo vencidas, solo pendientes, solo pagas. 

D — Acceso del Cobrador 

Vista simplificada: solo ve créditos activos y cuotas pendientes/vencidas. 

No accede al historial completo ni al resumen financiero global. 

No puede ver el domicilio completo del cliente, solo zona de cobro. 

E — Exportar cuenta del cliente 

Solo disponible para Admin. Exporta el estado de cuenta del cliente en PDF. 

Postcondiciones 

No se modifica ningún dato del sistema; es una operación de solo lectura. 

El acceso a la ficha queda registrado en el log de auditoría con el actor, fecha y hora de la consulta. 

Diferencia de vistas por rol 

Sección 

Admin 

Vendedor 

Cobrador 

Datos personales completos 

✓ 

✓ 

Parcial (sin domicilio) 

Resumen crediticio global 

✓ 

✓ 

— 

Indicador de riesgo 

✓ 

✓ 

✓ 

Créditos activos + cuotas 

✓ 

✓ 

✓ 

Créditos cancelados / rechazados 

✓ 

✓ 

— 

Detalle de cobrador por cuota 

✓ 

— 

— 

Exportar PDF estado de cuenta 

✓ 

— 

— 

 

CU07 — Registrar pre-carga de cobro 

Actores 

Actor principal: Cobrador 

Actor secundario: Admin / Dueño (puede ejecutar este caso de uso con los mismos permisos que el Cobrador) 

Precondiciones 

El usuario debe estar autenticado con rol Cobrador o Admin. 

Debe existir al menos un crédito activo con cuotas en estado PENDING o OVERDUE. 

El Cobrador debe haber realizado el cobro físicamente en calle antes de registrarlo en el sistema. 

El sistema debe estar operativo; idealmente con conexión, pero se contempla modo offline para cobradores en campo. 

Flujo principal — Registrar cobro de una cuota 

El Cobrador accede al módulo de Cobros desde su dispositivo móvil. 

El sistema muestra la lista de cuotas asignadas al Cobrador para el día, ordenadas por zona o recorrido. 

El Cobrador selecciona la cuota correspondiente al cliente que acaba de cobrar. 

El sistema muestra el detalle de la cuota: cliente, crédito asociado, monto original, estado actual y mora acumulada si aplica. 

El Cobrador ingresa: monto recibido y método de pago (CASH o TRANSFER). 

El Cobrador confirma el registro. 

El sistema persiste el pago con estado PENDING (pre-carga), a la espera de aprobación del Admin. 

El sistema no modifica el estado de la cuota todavía; permanece en su estado actual hasta que el Admin apruebe el cobro. 

El sistema retorna confirmación visual: "Pre-carga registrada correctamente. Pendiente de aprobación". 

El Admin recibe una notificación de nueva pre-carga pendiente de revisión. 

Flujos alternativos 

A — Cobro parcial 

Si el monto recibido es menor al monto de la cuota, el sistema lo identifica como pago parcial. 

El Cobrador puede agregar una observación explicando el motivo. 

Al aprobar el Admin, la cuota pasará a estado PARTIAL y el saldo restante quedará pendiente. 

B — Cobro por transferencia 

El Cobrador selecciona TRANSFER como método de pago. 

El sistema habilita un campo opcional para la referencia de la transferencia. 

C — Registrar cobro sin conexión (modo offline) 

El sistema almacena la pre-carga localmente en el dispositivo. 

Al recuperar la conexión, sincroniza automáticamente con el servidor. 

El Admin verá estas pre-cargas con una marca de sincronización tardía. 

D — Cobro duplicado 

Si la cuota ya tiene una pre-carga PENDING, el sistema muestra una advertencia. El Admin verá ambos registros y resolverá el conflicto. 

Postcondiciones 

La pre-carga queda registrada con estado PENDING asociada a la cuota y al cobrador que la registró. 

El estado de la cuota no cambia hasta que el Admin apruebe o rechace la pre-carga. 

Reglas de negocio relevantes 

Regla 

Descripción 

Doble control 

El cobrador registra, el Admin aprueba; ningún pago modifica el estado de la cuota sin aprobación 

Estado inmutable hasta aprobación 

La cuota mantiene su estado actual hasta que el Admin valide la pre-carga 

Cobro parcial permitido 

El sistema acepta montos menores al total de la cuota; el Admin define el tratamiento al aprobar 

Modo offline contemplado 

El Cobrador puede operar sin conexión y sincronizar luego 

Método de pago obligatorio 

No se puede registrar una pre-carga sin indicar si fue CASH o TRANSFER 

No se acepta monto cero 

El sistema bloquea el registro si el monto ingresado es cero o negativo 

 

CU08 — Aprobar o rechazar pre-ventas y pre-préstamos 

Actores 

Actor principal: Admin / Dueño (único rol con autorización para aprobar o rechazar operaciones crediticias) 

Actor notificado: Vendedor (recibe el resultado de la decisión sobre la operación que generó) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

Debe existir al menos una operación con estado PENDING_APPROVAL. 

Para pre-ventas: los productos asociados deben seguir activos y con stock suficiente al momento de aprobar. 

Flujo principal — Aprobar una pre-venta o pre-préstamo 

El Admin accede al módulo de Aprobaciones. 

El sistema muestra el listado de operaciones pendientes ordenadas por fecha de creación (más antiguas primero). 

El Admin selecciona una operación pendiente. 

El sistema muestra el detalle completo: datos del cliente con indicador de riesgo, tipo de crédito (SALE/LOAN), productos o monto, cantidad de cuotas, historial crediticio del cliente y alertas automáticas. 

El Admin analiza la información y selecciona Aprobar. 

El sistema ejecuta en una única transacción atómica: 

Cambia el estado del crédito de PENDING_APPROVAL a ACTIVE. 

Genera el cronograma completo de cuotas (INSTALLMENT) con fechas de vencimiento, monto por cuota y estado inicial PENDING. 

Si es SALE: descuenta el stock de cada producto involucrado (available_stock -= quantity). 

El sistema confirma la transacción y notifica al Vendedor que su operación fue aprobada. 

Flujo principal — Rechazar una pre-venta o pre-préstamo 

Pasos 1 al 4 idénticos al flujo de aprobación. 

El Admin selecciona Rechazar. 

El sistema solicita obligatoriamente un motivo de rechazo: "Cliente con mora activa", "Monto excede capacidad de pago", "Documentación insuficiente", "Decisión comercial" u "Otro". 

El Admin confirma el rechazo con el motivo ingresado. 

El sistema cambia el estado del crédito a REJECTED. El stock de productos no se modifica. 

El sistema notifica al Vendedor con el motivo del rechazo. 

Flujos alternativos 

A — Stock insuficiente al momento de aprobar 

El sistema bloquea la aprobación y muestra: "Stock insuficiente para el producto X. Disponible: N unidades. Solicitadas: M unidades". 

La operación permanece en PENDING_APPROVAL hasta que el Admin tome una decisión. 

B — Aprobación con modificación de cuotas 

Antes de aprobar, el Admin puede ajustar la cantidad de cuotas. El cambio queda registrado con una nota. 

C — Aprobación masiva 

El Admin puede seleccionar varias operaciones del listado y aprobarlas en lote. 

El sistema ejecuta una transacción por cada operación de forma independiente. 

D — Operación expirada por inactividad 

Si una operación lleva más de N días en PENDING_APPROVAL sin respuesta, el sistema la marca automáticamente como EXPIRED. 

Postcondiciones 

Si aprobada: 

El crédito queda en estado ACTIVE con su cronograma de cuotas generado y listo para el cobro. 

El stock de productos fue descontado de forma definitiva. 

Si rechazada: 

El crédito queda en estado REJECTED con motivo registrado. Ningún stock fue afectado. 

Reglas de negocio relevantes 

Regla 

Descripción 

Transacción atómica 

La aprobación genera cuotas y descuenta stock en una única operación; si falla cualquier paso, todo se revierte 

Motivo de rechazo obligatorio 

No se puede rechazar una operación sin registrar un motivo 

Stock se descuenta al aprobar 

Nunca antes; la pre-venta no reserva ni bloquea stock 

Cronograma generado al aprobar 

Las cuotas se crean en el momento exacto de la aprobación, con fechas calculadas desde ese día 

Solo el Admin aprueba 

Ningún otro rol puede modificar el estado de una operación crediticia 

Expiración automática 

Las operaciones sin respuesta por N días se marcan como EXPIRED automáticamente 

 

CU09 — Aprobar o rechazar pre-cargas de cobro 

Actores 

Actor principal: Admin / Dueño (único rol con autorización para validar los cobros registrados por los cobradores) 

Actor notificado: Cobrador (recibe el resultado de la decisión sobre la pre-carga que registró) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

Debe existir al menos una pre-carga con estado PENDING registrada por un Cobrador. 

Para cobros por transferencia: el Admin debe tener acceso al extracto bancario para cruzar la información. 

Flujo principal — Aprobar una pre-carga de cobro 

El Admin accede al módulo de Aprobación de Cobros. 

El sistema muestra el listado de pre-cargas pendientes con cliente, cobrador, cuota, monto registrado, método de pago y tiempo transcurrido. 

El Admin selecciona una pre-carga pendiente. 

El sistema muestra el detalle: datos del cliente, crédito y cuota; monto original y mora desglosada; monto recibido por el Cobrador; método de pago y referencia si aplica; diferencia entre esperado y recibido. 

El Admin verifica la información y selecciona Aprobar. 

El sistema determina el nuevo estado de la cuota: si amount_received >= amount_due → PAID; si amount_received < amount_due → PARTIAL. 

El sistema ejecuta en una transacción atómica: actualiza PAYMENT a APPROVED, actualiza INSTALLMENT a PAID o PARTIAL, y cierra el crédito si era la última cuota pendiente (ACTIVE → SETTLED). 

El sistema notifica al Cobrador que su pre-carga fue aprobada. 

Flujo principal — Rechazar una pre-carga de cobro 

Pasos 1 al 4 idénticos al flujo de aprobación. 

El Admin detecta una inconsistencia y selecciona Rechazar. 

El sistema solicita obligatoriamente un motivo: "Monto no coincide", "Transferencia no encontrada", "Cobro duplicado", "El cliente niega haber pagado" u "Otro". 

El sistema actualiza PAYMENT a REJECTED. La INSTALLMENT no se modifica; mantiene su estado anterior. 

El sistema notifica al Cobrador del rechazo con el motivo registrado. 

Flujos alternativos 

A — Aprobación de múltiples pre-cargas en lote 

Solo para cobros en efectivo sin discrepancias de monto. 

Las pre-cargas por transferencia se excluyen del lote; deben verificarse individualmente. 

B — Verificación de transferencia bancaria 

El Admin cruza la referencia ingresada por el Cobrador con el extracto bancario antes de aprobar. 

C — Cobrador corrige una pre-carga rechazada 

Tras el rechazo, el Cobrador puede registrar una nueva pre-carga corregida para la misma cuota. 

La pre-carga rechazada queda en el historial con estado REJECTED. 

Postcondiciones 

Si aprobada: 

El PAYMENT queda en estado APPROVED. La INSTALLMENT queda en estado PAID o PARTIAL. 

Si era la última cuota pendiente del crédito, el crédito pasa a estado SETTLED. 

Si rechazada: 

El PAYMENT queda en estado REJECTED. La INSTALLMENT mantiene su estado anterior sin cambios. 

Reglas de negocio relevantes 

Regla 

Descripción 

Transacción atómica 

La aprobación actualiza PAYMENT e INSTALLMENT en una sola operación; si falla, todo se revierte 

Doble control obligatorio 

Ningún cobro modifica el estado de una cuota sin la validación explícita del Admin 

Motivo de rechazo obligatorio 

No se puede rechazar sin registrar un motivo; protege al Cobrador y al Admin 

Cobros por transferencia individuales 

No se incluyen en aprobaciones en lote; requieren cruce con extracto bancario 

Crédito liquidado automáticamente 

Si la cuota aprobada era la última pendiente, el sistema cierra el crédito sin intervención manual 

Historial inmutable 

Las pre-cargas rechazadas permanecen en el historial; no se eliminan 

 

CU10 — Simular crédito / cotizador 

Actores 

Actor principal: Cliente (accede sin necesidad de autenticación desde el portal público) 

Actores secundarios: Vendedor y Admin (pueden usar el cotizador interno para orientar al cliente antes de generar una pre-venta) 

Precondiciones 

El portal público debe estar accesible y operativo. 

El sistema debe tener configuradas las tasas de interés y los rangos de cuotas habilitados por el Admin. 

No se requiere autenticación para acceder al cotizador público; es el único módulo del sistema completamente abierto. 

Flujo principal — Simular cuota desde el portal público 

El Cliente accede a la URL pública del sistema desde cualquier dispositivo. 

El sistema muestra el formulario del cotizador: tipo de operación (préstamo o compra), monto deseado y cantidad de cuotas. 

El Cliente completa los campos y solicita la simulación. 

El sistema calcula en tiempo real: monto por cuota, tasa de interés aplicada, monto total a pagar y costo financiero total (CFT). 

El Cliente puede ajustar el monto o cuotas y el sistema recalcula instantáneamente. 

Si el Cliente está interesado, el sistema muestra: "¿Te interesa? Acercate a nuestro local o contactanos", con datos de contacto del negocio. 

Flujos alternativos 

A — Simulación desde el sistema interno (Vendedor o Admin) 

El flujo es idéntico al público pero integrado dentro del módulo de Nueva Operación. 

Desde el resultado, el Vendedor puede iniciar directamente la generación de una pre-venta usando el botón "Generar operación con estos datos". 

B — Comparador de cuotas 

El sistema puede mostrar una tabla comparativa con todas las opciones de cuotas disponibles para el mismo monto, mostrando cómo varía la cuota mensual y el costo total según el plazo. 

Postcondiciones 

No se persiste ningún dato en la base de datos; la simulación es completamente efímera y anónima. 

El sistema puede registrar métricas anónimas de uso del cotizador como información de valor comercial para el Admin, sin datos personales del visitante. 

Reglas de negocio relevantes 

Regla 

Descripción 

Sin autenticación 

El cotizador es público y no requiere login bajo ninguna circunstancia 

Sin JWT 

El endpoint de cálculo no requiere token; es el único endpoint abierto de la API 

Tasas configurables 

Las tasas de interés por cantidad de cuotas las define el Admin desde el panel 

Cálculo sin persistencia 

Ninguna simulación genera registros en la base de datos 

Resultados orientativos 

El sistema aclara que los resultados son una estimación y que la operación real queda sujeta a aprobación 

 

CU11 — Ver estado de cuenta propio 

Actores 

Actor principal: Cliente (accede desde el portal público con sus credenciales propias) 

Actor de soporte: Admin / Dueño (puede habilitar, deshabilitar o resetear el acceso del cliente al portal) 

Precondiciones 

El Cliente debe estar registrado en el sistema por parte del Vendedor o Admin. 

El Admin debe haber habilitado el acceso al portal para ese cliente y haberle comunicado sus credenciales. 

El portal público debe estar accesible y operativo. 

Flujo principal — Acceder y consultar el estado de cuenta 

El Cliente accede a la URL pública del portal desde cualquier dispositivo. 

El sistema muestra la pantalla de inicio con dos opciones: Cotizador (sin login) y Mi cuenta (con login). 

El Cliente selecciona Mi cuenta e ingresa sus credenciales: DNI y contraseña. 

El sistema valida las credenciales y verifica que el cliente esté activo. 

El sistema genera un token de sesión de 30 minutos de inactividad y redirige al panel del cliente. 

El sistema muestra el resumen de cuenta con tres secciones: 

Sección 1 — Bienvenida: nombre, total adeudado, cuotas al día/mora/pagas, indicador de estado (Verde/Amarillo/Rojo). 

Sección 2 — Próximos vencimientos: cuotas a vencer en los siguientes 30 días, ordenadas cronológicamente. 

Sección 3 — Mis créditos: listado de créditos activos con tipo, monto, cuotas pagas sobre total y estado general. Al expandir cada crédito se muestra el cronograma completo. 

El Cliente navega libremente por las secciones disponibles. 

Al finalizar, el Cliente puede cerrar sesión manualmente o la sesión expira automáticamente por inactividad. 

Flujos alternativos 

A — Credenciales incorrectas 

El sistema muestra: "DNI o contraseña incorrectos. Verificá tus datos e intentá nuevamente". 

Tras tres intentos fallidos consecutivos, el sistema bloquea el acceso. 

B — Primer acceso y cambio de contraseña obligatorio 

Si es la primera vez que el cliente accede, el sistema lo redirige obligatoriamente a la pantalla de cambio de contraseña antes de mostrar el panel. 

C — Cliente sin acceso habilitado al portal 

El sistema muestra: "Tu acceso al portal aún no fue habilitado. Comunicarte con el negocio para solicitarlo". 

D — Sesión expirada por inactividad 

El sistema redirige al login con el mensaje: "Tu sesión expiró por inactividad. Ingresá nuevamente". 

Postcondiciones 

No se modifica ningún dato del sistema; es una operación de solo lectura. 

El acceso al portal queda registrado en el log de auditoría con fecha, hora y dispositivo utilizado. 

Reglas de negocio relevantes 

Regla 

Descripción 

Alta de acceso por Admin 

El cliente no puede autoregistrarse; el Admin habilita el acceso y comunica las credenciales 

DNI como identificador de login 

El cliente accede con su DNI y una contraseña, no con email 

Cambio de contraseña en primer acceso 

Obligatorio; no se puede omitir 

Sesión con expiración automática 

La sesión expira tras 30 minutos de inactividad 

Solo lectura absoluta 

El cliente no puede modificar ningún dato propio desde el portal 

Bloqueo por intentos fallidos 

Tres intentos fallidos consecutivos bloquean el acceso 

Visibilidad acotada 

El cliente solo ve sus propios créditos y cuotas; nunca datos de otros clientes 

Token de corta duración 

El JWT del portal público tiene una vida útil menor a la del sistema interno por seguridad 

 

CU12 — Gestionar caja y reportes 

Actores 

Actor principal: Admin / Dueño (único rol con acceso completo al módulo de caja y reportes) 

Actor indirecto: Cobrador (sus cobros aprobados alimentan la caja; no accede al módulo) 

Actor indirecto: Vendedor (sus operaciones aprobadas impactan en los reportes; no accede al módulo) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

Deben existir pagos aprobados y/o créditos activos en el sistema para que los reportes tengan datos. 

Flujo principal — Apertura y seguimiento de caja diaria 

El Admin accede al módulo de Caja y Reportes. 

El sistema muestra el dashboard de caja del día con: total recaudado, desglose por método de pago, cantidad de cobros procesados, cobros pendientes y comparativo con el día anterior. 

El Admin monitorea los ingresos a medida que aprueba pre-cargas durante el día. 

Al finalizar la jornada, el Admin ejecuta el cierre de caja diario. 

El sistema valida que no queden pre-cargas PENDING del día sin resolver y alerta si las hay. 

El Admin confirma el cierre indicando el monto físico contado en efectivo. 

El sistema compara el efectivo declarado con el total de cobros en efectivo aprobados del día y calcula la diferencia (sobrante o faltante). 

El sistema registra el cierre con fecha, hora, monto total, desglose y diferencia, y genera el comprobante de cierre. 

Flujo alternativo principal — Consultar reportes históricos 

El Admin accede a la sección de Reportes dentro del módulo. 

El sistema presenta las categorías: reporte de recaudación, cartera de créditos, mora, cobradores y productos vendidos. 

El Admin selecciona el reporte, define el rango de fechas y aplica los filtros disponibles. 

El sistema presenta los resultados con gráficos y tabla de detalle. 

El Admin puede exportar en PDF o CSV. 

Flujos alternativos 

A — Reporte de recaudación 

Total recaudado en el período, desglose diario con gráfico de barras, distribución por método de pago, promedio diario y días con mayor/menor recaudación. 

B — Reporte de cartera de créditos 

Total de créditos activos/liquidados/rechazados, monto total de cartera activa, distribución por tipo y por cantidad de cuotas. 

C — Reporte de mora 

Total de cuotas vencidas con monto acumulado, porcentaje de mora sobre la cartera activa, listado de clientes con mora ordenado por monto, y antigüedad de la mora. 

D — Reporte de cobradores 

Por cada cobrador: cobros registrados, monto recaudado, pre-cargas rechazadas y tasa de efectividad. 

E — Reporte de productos vendidos 

Ranking de productos más vendidos, stock actual, productos con stock bajo y productos sin movimiento. 

F — Diferencia de caja al cierre 

Si hay sobrante: se registra con estado SOBRANTE. Si hay faltante: se registra con estado FALTANTE y el Admin puede agregar una observación. En ambos casos el cierre se registra igual; la diferencia no bloquea el proceso. 

Postcondiciones 

El cierre de caja queda registrado con fecha, hora, monto, desglose y diferencia. Es inmutable. 

Los reportes generados no modifican ningún dato del sistema. 

Los exportes generados quedan disponibles para descarga durante 24 horas. 

Reglas de negocio relevantes 

Regla 

Descripción 

Un cierre por día 

El sistema permite un solo cierre de caja por jornada; no se puede cerrar dos veces el mismo día 

Cierre inmutable 

Una vez registrado el cierre, no se puede modificar; solo se pueden agregar notas aclaratorias 

Diferencia no bloquea 

El faltante o sobrante se registra pero no impide el cierre ni requiere resolución inmediata 

Solo Admin accede 

Ningún otro rol tiene visibilidad sobre caja, reportes ni cierres 

Trazabilidad completa 

Cada peso registrado en caja tiene trazabilidad hasta el cobrador, cuota y cliente de origen 

Exportes temporales 

Los archivos generados se eliminan del servidor automáticamente tras 24 horas 

 

CU13 — Aplicar mora y cancelación anticipada 

Parte 1 — Aplicar mora a una cuota vencida 

Actores 

Actor principal: Admin / Dueño (único rol que puede aplicar mora manualmente o configurar la aplicación automática) 

Actor notificado: Cliente (puede ver la mora aplicada desde su portal) 

Actor notificado: Cobrador (ve el nuevo monto a cobrar en su lista de cuotas) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

Debe existir al menos una cuota con estado OVERDUE. 

El sistema debe tener configurado el porcentaje o monto fijo de mora a aplicar. 

Flujo principal — Aplicar mora manualmente 

El Admin accede al módulo de Créditos o al reporte de mora. 

El sistema muestra el listado de cuotas vencidas con cliente, número de cuota, monto original, días de atraso y si ya tienen mora aplicada. 

El Admin selecciona una cuota vencida sin mora aplicada. 

El sistema muestra el detalle y el monto de mora calculado automáticamente según la configuración vigente. 

El Admin revisa el cálculo y confirma la aplicación de mora. 

El sistema ejecuta en una transacción atómica: calcula el monto de mora, actualiza el amount_due de la cuota sumando el recargo, registra el monto original y la mora de forma desglosada, y mantiene el estado en OVERDUE. 

El Cobrador y el Cliente ven el nuevo monto actualizado. 

Flujo alternativo — Aplicación automática de mora 

Un proceso programado (cron job) se ejecuta diariamente a una hora fija y evalúa todas las cuotas con estado PENDING cuya due_date es anterior a la fecha actual. 

Por cada cuota que cumple la condición, el sistema cambia su estado a OVERDUE y aplica la mora configurada automáticamente. 

El Admin recibe un resumen diario indicando cuántas cuotas pasaron a mora ese día. 

Flujos alternativos 

A — Condonar mora 

El Admin puede condonar la mora a un cliente por acuerdo comercial o error. 

El sistema revierte el amount_due al monto original y registra la condonación con el motivo y el Admin que la ejecutó. 

B — Mora aplicada a múltiples cuotas en lote 

El Admin puede seleccionar varias cuotas vencidas y aplicar mora en lote. El sistema procesa cada cuota de forma independiente. 

Reglas de negocio relevantes 

Regla 

Descripción 

Solo sobre cuotas OVERDUE 

No se puede aplicar mora a cuotas en estado PENDING, PAID o PARTIAL 

Desglose obligatorio 

El sistema siempre registra por separado el monto original y el recargo por mora 

Condonación auditable 

Revertir una mora queda registrado; no se borra el historial 

Mora máxima configurable 

El sistema respeta el tope máximo definido por el Admin; no acumula mora indefinidamente 

Aplicación automática opcional 

La mora puede ser manual o automática según la configuración del negocio 

Días de gracia respetados 

El cron job no aplica mora a cuotas dentro del período de gracia configurado 

 

Parte 2 — Cancelación anticipada de un crédito 

Actores 

Actor principal: Admin / Dueño (único rol que puede ejecutar la cancelación anticipada) 

Actor solicitante: Cliente (solicita la cancelación en persona o por contacto directo; no la ejecuta desde el portal) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

Debe existir un crédito en estado ACTIVE con cuotas pendientes. 

El cliente debe haber manifestado su intención de cancelar anticipadamente. 

Flujo principal — Procesar cancelación anticipada 

El Admin accede al módulo de Créditos y busca el crédito del cliente. 

El sistema muestra la ficha del crédito con el cronograma completo de cuotas. 

El Admin selecciona la opción Cancelación anticipada sobre el crédito activo. 

El sistema calcula automáticamente el monto de cancelación: capital restante de cuotas pendientes/vencidas, descuento de intereses no devengados si aplica, más mora acumulada. Presenta el monto final desglosado. 

El Admin confirma el monto con el cliente y selecciona Confirmar cancelación anticipada. 

El sistema solicita el método de pago: CASH o TRANSFER. 

El Admin confirma el cobro del monto de cancelación. 

El sistema ejecuta en una transacción atómica: marca todas las cuotas pendientes y vencidas como PAID, registra un único pago de cancelación en PAYMENT y cambia el estado del crédito de ACTIVE a SETTLED. 

El sistema genera el comprobante de cancelación anticipada. El Admin lo entrega al cliente. 

Reglas de negocio relevantes 

Regla 

Descripción 

Solo sobre créditos ACTIVE 

No se puede cancelar anticipadamente un crédito ya SETTLED, REJECTED o EXPIRED 

Transacción atómica 

Todas las cuotas se marcan PAID y el crédito se cierra en una sola operación; si falla, todo se revierte 

Descuento de intereses configurable 

La política de bonificación por cancelación temprana la define el Admin 

Mora incluida en el cálculo 

Las deudas por mora se suman al monto de cancelación salvo que el Admin las condone previamente 

Comprobante obligatorio 

El sistema siempre genera un comprobante de cancelación para resguardo del cliente y del negocio 

Operación irreversible 

Una vez confirmada la cancelación, el crédito no puede volver a estado ACTIVE 

 

CU14 — Generar planilla de cobro 

Actores 

Actor principal: Admin / Dueño (genera, configura y emite la planilla) 

Actor secundario: Cobrador (consulta la planilla digital desde su dispositivo durante el recorrido) 

Precondiciones 

El usuario que genera debe estar autenticado con rol Admin. 

Deben existir cobradores activos con clientes asignados en el sistema. 

Deben existir cuotas con estado PENDING o OVERDUE correspondientes a los clientes asignados a cada cobrador. 

Cada cliente debe tener un cobrador asignado; los clientes sin cobrador asignado no aparecen en ninguna planilla. 

Flujo principal — Generar planilla de cobro del día 

El Admin accede al módulo de Planillas de Cobro. 

El sistema muestra las opciones de generación: fecha de cobro, cobrador (selector o todos) y filtro de cuotas a incluir (solo vencidas, solo del día, vencidas más del día, o todas las pendientes). 

El Admin configura los parámetros y solicita la generación. 

El sistema agrupa las cuotas a cobrar por cobrador, ordenadas por zona o recorrido definido en el perfil del cliente. 

El sistema genera la planilla con: número de orden, nombre y domicilio del cliente, teléfono de contacto, número de crédito y tipo, número de cuota, fecha de vencimiento, monto a cobrar con mora desglosada, y campos en blanco para anotar monto recibido y observaciones (versión impresa). 

El sistema muestra la planilla en pantalla con vista previa de impresión. 

El Admin revisa y confirma la impresión. 

El sistema genera el PDF y lo deja disponible para descarga o envío a la impresora. 

El Admin imprime la planilla y la entrega físicamente al Cobrador antes del recorrido. 

La planilla queda registrada en el sistema como emitida, disponible para consulta digital del Cobrador durante todo el día. 

Flujos alternativos 

A — Generación masiva para todos los cobradores 

El Admin selecciona la opción "Generar para todos los cobradores". 

El sistema genera una planilla independiente por cada cobrador activo con cuotas asignadas. 

El Admin puede descargar un archivo ZIP con todas las planillas del día. 

B — Cobrador consulta la planilla digital desde su dispositivo 

Durante el recorrido, el Cobrador accede al sistema desde su celular y accede al módulo "Mi planilla del día". 

El sistema muestra solo la planilla del día vigente asignada a ese Cobrador; no puede ver las de otros cobradores. 

La vista digital está optimizada para mobile: una tarjeta por cliente con la información esencial grande y legible. 

C — Reimpresión de planilla ya emitida 

El sistema indica claramente que es una reimpresión con la leyenda "REIMPRESIÓN — Emitida originalmente el DD/MM/AAAA HH:MM". 

D — Clientes sin cobrador asignado 

El sistema alerta al Admin antes de generar: "Hay N clientes con cuotas pendientes sin cobrador asignado. Estos clientes no aparecerán en ninguna planilla". 

E — Planilla del día anterior no gestionada 

Las cuotas vencidas de días anteriores no cobradas se incluyen automáticamente en la planilla del día vigente con la indicación de los días de atraso. 

Postcondiciones 

La planilla queda registrada en el sistema como emitida con fecha, hora, cobrador y parámetros de generación. 

La versión digital queda disponible para el Cobrador durante todo el día vigente; al día siguiente pasa al historial. 

Las cuotas incluidas en la planilla no cambian de estado; la planilla es un documento informativo, no una operación transaccional. 

Reglas de negocio relevantes 

Regla 

Descripción 

Cobrador asignado obligatorio 

Solo aparecen en planilla los clientes con cobrador asignado; los demás quedan fuera y el sistema alerta 

Una planilla activa por cobrador por día 

No se generan dos planillas distintas para el mismo cobrador el mismo día; la segunda generación reemplaza a la anterior 

Solo lectura para el Cobrador 

El Cobrador consulta pero no puede modificar la planilla digital ni los datos de los clientes 

Planilla no transaccional 

Generar la planilla no modifica estados de cuotas, pagos ni créditos 

Arrastre automático de vencidas 

Las cuotas no cobradas de días anteriores se incluyen automáticamente en la planilla del día siguiente 

Visibilidad del Cobrador acotada 

Cada cobrador solo puede ver su propia planilla; nunca la de otro cobrador 

Mora desglosada en planilla 

El monto mostrado al Cobrador siempre es el total a cobrar con mora desglosada, para que no haya confusión en calle 

 

CU15 — Gestionar comisiones y liquidaciones 

Actores 

Actor principal: Admin / Dueño (único rol que ejecuta liquidaciones y registra pagos) 

Actor secundario: Vendedor / Cobrador-Vendedor (genera comisiones al vender y consulta su resumen semanal) 

Actor notificado: Vendedor / Cobrador-Vendedor (recibe confirmación del pago de su liquidación) 

Precondiciones 

El usuario debe estar autenticado con rol Admin (para liquidar) o Vendedor/Cobrador (para consultar). 

Deben existir ventas de productos (tipo SALE) aprobadas en el período para que haya comisiones generadas. 

Cada Vendedor o Cobrador-Vendedor debe tener configurada su tasa de comisión (8%) en el sistema. 

Los Cobradores con sueldo fijo deben tener su monto semanal configurado en el sistema. 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

 

Flujo principal — Generación automática de comisión al aprobar una venta 

El Admin aprueba una pre-venta de producto (crédito tipo SALE) desde el módulo de Aprobaciones. 

El sistema ejecuta, dentro de la misma transacción atómica de aprobación del crédito:  

Cambia el estado del crédito a ACTIVE. 

Genera el cronograma de cuotas. 

Descuenta el stock del producto. 

Calcula la comisión: total_amount × 0.08. 

Registra un nuevo registro en la tabla COMMISSION con estado PENDING, asociado al Vendedor que generó la operación y al crédito aprobado. 

Asigna la comisión al ciclo semanal vigente (lunes a sábado de la semana en curso). 

El registro de comisión queda acumulado automáticamente sin intervención adicional del Admin. 

El Vendedor puede ver la nueva comisión reflejada en su panel de comisiones de la semana. 

 

Flujo principal — Ejecutar liquidación semanal (lunes) 

El Admin accede al módulo de Comisiones y Liquidaciones. 

El sistema muestra el resumen de la semana cerrada (lunes anterior al sábado inclusive):  

Por cada Vendedor/Cobrador-Vendedor: listado de ventas aprobadas en el período, monto de cada comisión generada, comisiones negativas por mora si aplica, y total neto a cobrar. 

Por cada Cobrador con sueldo fijo: monto semanal configurado. 

Total general de egresos a ejecutar en el día. 

El Admin revisa los totales empleado por empleado. 

El Admin selecciona un empleado y ejecuta su liquidación individual o selecciona liquidar a todos en lote. 

Para cada liquidación, el sistema solicita el método de pago: CASH o TRANSFER. 

El Admin confirma el pago. 

El sistema ejecuta en una transacción atómica:  

Actualiza todas las comisiones del período del empleado de PENDING a PAID. 

Registra el registro en la tabla COMMISSION_LIQUIDATION con el total pagado, método de pago, Admin que ejecutó y timestamp. 

Registra el egreso en el cierre de caja del día (tabla CASH_REGISTER) como salida de dinero. 

El sistema notifica al Vendedor que su liquidación fue procesada con el monto recibido. 

 

Flujos alternativos 

A — Comisión revertida por mora (signo negativo) 

Cuando el Admin aplica mora a un crédito de tipo SALE, el sistema verifica si ese crédito tiene comisiones en estado PENDING o PAID asociadas. 

Si la comisión está en estado PENDING (aún no fue liquidada): el sistema crea un registro de comisión con monto negativo (-total_amount × 0.08) y estado REVERSED, que se suma al ciclo de la semana actual. Al liquidar, el total neto puede ser menor o incluso negativo. 

Si la comisión ya fue PAID (ya se liquidó): el sistema crea igualmente el registro negativo en el ciclo vigente, descontándose de la próxima liquidación. 

Nunca se elimina un registro de comisión; se compensan con registros negativos para mantener el historial completo. 

B — Total neto negativo en una liquidación 

Si las comisiones negativas por mora superan las comisiones positivas del período, el total neto del Vendedor es negativo. 

El sistema muestra una alerta al Admin: "El total neto del Vendedor X es negativo ($-YYY). El saldo se arrastrará al próximo ciclo semanal". 

No se registra un pago negativo; el saldo negativo se arrastra automáticamente como deuda del empleado hacia la semana siguiente. 

C — Vendedor consulta su resumen semanal 

El Vendedor accede a la sección "Mis comisiones" desde el sistema interno. 

El sistema muestra el ciclo vigente (semana actual, lunes a sábado):  

Listado de ventas aprobadas en la semana con fecha, cliente, monto del crédito y comisión generada por cada una. 

Comisiones negativas por mora si las hay, con el crédito que las originó. 

Total acumulado neto de la semana. 

Historial de liquidaciones anteriores con fecha de pago, monto recibido y método de pago. 

El Vendedor puede ver el estado de cada comisión: PENDING (semana en curso, aún no liquidada) o PAID (ya cobrada en una liquidación anterior). 

El Vendedor no puede modificar ningún dato; es una vista de solo lectura. 

D — Cobrador con sueldo fijo consulta su resumen 

El Cobrador accede a la sección "Mi liquidación" y ve:  

Su monto de sueldo fijo semanal configurado. 

Si también realizó ventas en la semana, ve además las comisiones generadas por esas ventas. 

Total a cobrar el próximo lunes. 

Historial de pagos anteriores. 

E — Modificar monto de sueldo fijo de un Cobrador 

El Admin accede a la ficha del usuario Cobrador y edita el campo de sueldo semanal. 

El cambio aplica desde el ciclo semanal siguiente, no retroactivamente. 

El sistema registra el cambio con fecha y el Admin que lo ejecutó para auditoría. 

F — Liquidación parcial (pago de solo algunos empleados) 

El Admin puede liquidar empleado por empleado en lugar de hacerlo en lote. 

Útil cuando la empresa no tiene liquidez suficiente para pagar a todos el mismo día. 

Los empleados no liquidados mantienen sus comisiones en estado PENDING y se acumulan al siguiente ciclo. 

El sistema no obliga a liquidar a todos el mismo lunes; solo alerta si hay comisiones con más de una semana de antigüedad sin liquidar. 

G — Consulta de historial de liquidaciones (Admin) 

El Admin puede ver el historial completo de todas las liquidaciones ejecutadas, filtradas por empleado, semana o rango de fechas. 

Puede ver el detalle de cada liquidación: qué ventas la compusieron, si hubo comisiones negativas, monto total pagado y método de pago. 

El historial es de solo lectura; no se pueden modificar liquidaciones ya ejecutadas. 

H — Pago por transferencia 

En el paso 5 del flujo principal, si el Admin selecciona TRANSFER como método de pago, el sistema habilita un campo opcional para ingresar la referencia bancaria. 

El registro de la liquidación queda con el método TRANSFER y la referencia ingresada. 

I — Cierre de ciclo semanal automático (sábado a la noche) 

Un proceso programado (cron job) se ejecuta automáticamente los sábados a las 23:59 hs. 

El sistema cierra el ciclo semanal vigente: todas las comisiones en estado PENDING de ese ciclo quedan marcadas como "ciclo cerrado, pendiente de pago". 

Se abre automáticamente el nuevo ciclo de la semana siguiente. 

El Admin recibe una notificación el lunes indicando el total de egresos a ejecutar ese día. 

 

Postcondiciones 

Si la liquidación fue ejecutada: 

Todas las comisiones del período del empleado quedan en estado PAID. 

El registro de liquidación queda en COMMISSION_LIQUIDATION con todos sus datos. 

El egreso queda registrado en el cierre de caja del día. 

El Vendedor ve su historial actualizado con el nuevo pago. 

Si no se ejecutó la liquidación: 

Las comisiones permanecen en PENDING y se acumulan al ciclo siguiente. 

El saldo negativo (si aplica) se arrastra como deuda del empleado. 

 

Reglas de negocio relevantes 

Regla 

Descripción 

Solo ventas generan comisión 

Los préstamos en efectivo (tipo LOAN) no generan comisión bajo ninguna circunstancia 

Tasa del 8% sobre monto total 

La comisión se calcula sobre el total_amount del crédito aprobado, no sobre los intereses ni las cuotas individuales 

Comisión nace al aprobar la venta 

El registro de comisión se crea en la misma transacción atómica que aprueba el crédito y descuenta el stock 

Ciclo semanal lunes a sábado 

El cierre del ciclo ocurre automáticamente los sábados a las 23:59 hs 

Pago los lunes 

El día de liquidación es el lunes; el sistema alerta al Admin con el resumen a ejecutar 

Compensación por mora, nunca eliminación 

Las comisiones revertidas se registran como negativos; nunca se borran registros del historial 

Saldo negativo se arrastra 

Si el neto de un empleado es negativo, se descuenta del próximo ciclo; no se generan pagos negativos 

Sueldo fijo estandarizado a semanal 

Todos los Cobradores con sueldo fijo se liquidan semanalmente, independientemente de si antes cobraban mensual 

Egreso de caja registrado 

El pago de liquidaciones del lunes impacta obligatoriamente en el cierre de caja de ese día 

Solo el Admin liquida 

Ningún otro rol puede ejecutar pagos o modificar liquidaciones 

Vista de solo lectura para Vendedores 

El Vendedor consulta pero no puede modificar sus comisiones ni historial 

 

Diagrama de estados de una comisión 

Venta aprobada 
     │ 
     ▼ 
 [PENDING] ── ciclo abierto, semana en curso 
     │ 
     ├── Admin liquida el lunes ──────────────► [PAID] 
     │ 
     ├── Mora aplicada al crédito ───────────► registro REVERSED (negativo) 
     │         └── compensa en la próxima liquidación 
     │ 
     └── Ciclo cierra sábado 23:59 ──────────► PENDING con ciclo cerrado 
                                                 │ 
                                           Admin liquida el lunes 
                                                 │ 
                                               [PAID] 

 

Fórmula de cálculo 

Comisión por venta: 
 comision = credit.total_amount × 0.08 
 
Total neto del empleado en un ciclo: 
 neto = Σ comisiones PENDING del ciclo 
      + sueldo_semanal (si es Cobrador con fijo, 0 si es Vendedor puro) 
      + Σ comisiones REVERSED del ciclo (valores negativos) 
 
Si neto < 0: 
 → No se paga; el saldo negativo se arrastra al ciclo siguiente como: 
   comision_arrastre = neto (negativo) 
   que se suma al ciclo de la semana entrante 

 

 

 

Relación con otras entidades del DER 

COMMISSION 
├── id              PK 
├── user_id         FK → USER (vendedor que generó la venta) 
├── credit_id       FK → CREDIT (solo type = SALE) 
├── amount          → total_amount × 0.08 (negativo si es REVERSED) 
├── status          → PENDING | PAID | REVERSED 
├── week_start      → lunes del ciclo 
├── week_end        → sábado del ciclo 
└── created_at      → timestamp de la aprobación del crédito 
 
SALARY (sueldo fijo de cobradores) 
├── id              PK 
├── user_id         FK → USER (solo Cobradores) 
├── weekly_amount   → monto semanal fijo 
└── active          → boolean (permite desactivar sin eliminar) 
 
COMMISSION_LIQUIDATION (pago semanal del lunes) 
├── id                  PK 
├── user_id             FK → USER (empleado liquidado) 
├── week_start          → lunes del ciclo liquidado 
├── week_end            → sábado del ciclo liquidado 
├── commissions_total   → suma de comisiones PENDING del período 
├── salary_amount       → sueldo fijo si aplica (0 para Vendedores puros) 
├── total_paid          → commissions_total + salary_amount 
├── payment_method      → CASH | TRANSFER 
├── transfer_reference  → referencia bancaria (opcional) 
├── paid_by             FK → USER (Admin que ejecutó el pago) 
├── cash_register_id    FK → CASH_REGISTER (cierre de caja del lunes) 
└── paid_at             → timestamp del pago 

 

Diferencia entre Cobrador puro y Cobrador-Vendedor 

Aspecto 

Cobrador puro 

Cobrador-Vendedor 

Vendedor puro 

Sueldo fijo semanal 

✓ 

✓ 

— 

Genera comisiones por ventas 

— 

✓ (8%) 

✓ (8%) 

Comisión por cobros en calle 

— 

— 

— 

Aparece en planilla de cobro 

✓ 

✓ 

— 

Puede generar pre-ventas 

— 

✓ 

✓ 

Liquidación el lunes 

Sueldo fijo 

Sueldo fijo + comisiones 

Solo comisiones  

 

CU16 — Configuracion de parametros del sistema 

Actores 

Actor principal: Admin / Dueño (único rol con acceso al módulo de configuración) 

Precondiciones 

El usuario debe estar autenticado con rol Admin. 

El sistema debe estar operativo con conexión a la base de datos PostgreSQL. 

 

Flujo principal — Consultar y modificar un parámetro 

El Admin accede al módulo de Configuración del sistema. 

El sistema muestra todos los parámetros agrupados en secciones:  

Créditos: montos mínimo y máximo del cotizador, días para expiración de operaciones pendientes. 

Tasas de interés: matriz completa por tipo de operación, frecuencia y cantidad de cuotas. 

Mora: días de gracia, tipo de mora (porcentaje diario, mensual fijo o monto fijo), porcentaje y tope máximo. 

Comisiones: porcentaje de comisión por venta, día de cierre del ciclo semanal, día de pago. 

Seguridad: intentos de login antes de bloqueo, expiración del JWT interno y del portal público. 

El Admin selecciona el parámetro que desea modificar. 

El sistema muestra el valor actual y un campo editable con validación según el tipo de dato. 

El Admin ingresa el nuevo valor y confirma. 

El sistema valida que el valor esté dentro del rango permitido para ese parámetro. 

El sistema persiste el nuevo valor en system_config, registrando el Admin que lo modificó y el timestamp del cambio. 

El sistema muestra confirmación: "Parámetro actualizado correctamente". 

 

Flujo principal — Gestionar tabla de tasas de interés 

El Admin accede a la sección Tasas de interés dentro del módulo de Configuración. 

El sistema muestra la matriz completa organizada en dos grillas separadas: una para SALE (ventas) y otra para LOAN (préstamos), con columnas por frecuencia (Semanal, Quincenal, Mensual) y filas por cantidad de cuotas. 

El Admin puede:  

Editar el porcentaje de cualquier celda existente. 

Agregar una nueva combinación de cuotas y frecuencia. 

Desactivar una combinación para que no aparezca en el cotizador (sin eliminarla). 

Al editar una tasa, el sistema guarda el nuevo valor y registra la fecha del cambio. 

El cambio aplica únicamente a créditos nuevos. Los créditos ya aprobados conservan la tasa original registrada en credits.interest_rate (snapshot inmutable). 

 

Flujos alternativos 

A — Valor fuera de rango 

Si el Admin ingresa un valor inválido (ej: tasa negativa, monto mínimo mayor al máximo, días de gracia negativos), el sistema muestra el mensaje de error correspondiente y no persiste el cambio. 

B — Desactivar una combinación de tasas 

El Admin puede marcar como active = FALSE cualquier combinación de cuotas y frecuencia. 

La combinación desaparecerá del cotizador y del selector del Vendedor al generar una operación. 

Los créditos ya generados con esa combinación no se ven afectados. 

C — Agregar nueva combinación de cuotas 

El Admin puede agregar una fila nueva a la matriz (ej: habilitar 18 cuotas mensuales que antes no existía). 

El sistema valida que no exista ya una combinación activa con los mismos valores de installments_count, payment_frequency y credit_type. 

Si existe una desactivada, el sistema la reactiva en lugar de crear un duplicado. 

D — Historial de cambios de configuración 

Cada modificación en system_config queda registrada con el valor anterior, el nuevo valor, el Admin que lo cambió y el timestamp. 

El Admin puede consultar el historial de cambios para auditar cuándo y quién modificó cada parámetro. 

E — Restaurar valor por defecto 

El Admin puede restaurar cualquier parámetro a su valor original de fábrica con un botón "Restaurar valor por defecto". 

El sistema muestra el valor de fábrica y solicita confirmación antes de aplicarlo. 

 

Postcondiciones 

El parámetro modificado tiene efecto inmediato sobre las nuevas operaciones del sistema. 

Los créditos y operaciones ya existentes no se ven afectados por ningún cambio de configuración. 

Todo cambio queda registrado con fecha, hora y Admin que lo ejecutó. 

 

Reglas de negocio relevantes 

Regla 

Descripción 

Solo el Admin configura 

Ningún otro rol tiene acceso al módulo de configuración 

Cambios prospectivos 

Ningún cambio de configuración afecta retroactivamente operaciones ya registradas 

Snapshot en créditos 

La tasa vigente al aprobar se guarda en credits.interest_rate y es inmutable 

Snapshot en planillas 

El monto al emitir la planilla se guarda en collection_sheet_details.planned_amount 

Sin eliminación física 

Las combinaciones de tasas se desactivan, nunca se eliminan 

Validación de rangos 

Cada parámetro tiene un rango permitido; el sistema rechaza valores inválidos 

Auditoría obligatoria 

Todo cambio queda registrado; no hay modificaciones anónimas 

 

 

 

Parámetros del sistema — referencia completa 

Parámetro 

Descripción 

Valor por defecto 

commission_rate 

Tasa de comisión por venta (decimal) 

0.08 (8%) 

penalty_grace_days 

Días de gracia antes de aplicar mora 

3 

penalty_rate_daily 

Porcentaje diario de mora 

0.005 (0.5%) 

penalty_max_rate 

Tope máximo de mora acumulable 

0.50 (50%) 

credit_expiry_days 

Días en PENDING antes de expirar 

7 

min_credit_amount 

Monto mínimo en el cotizador 

$1.000 

max_credit_amount 

Monto máximo en el cotizador 

$500.000 

jwt_expiry_internal_hs 

Expiración JWT sistema interno 

8 horas 

jwt_expiry_portal_min 

Expiración JWT portal público 

30 minutos 

login_max_attempts 

Intentos fallidos antes del bloqueo 

3 

commission_week_close_day 

Día de cierre del ciclo (ISO) 

6 (sábado) 

commission_pay_day 

Día de pago de liquidaciones (ISO) 

1 (lunes) 

 

Relación con otras entidades del DER 

SYSTEM_CONFIG 
├── key         → identificador único del parámetro 
├── value       → valor actual (siempre string, se castea en el código) 
├── description → descripción legible para el Admin 
├── updated_at  → timestamp del último cambio 
└── updated_by  → FK a USER (Admin que hizo el último cambio) 
 
INTEREST_RATES (se gestiona desde el mismo módulo) 
├── installments_count → cantidad de cuotas 
├── payment_frequency  → WEEKLY | BIWEEKLY | MONTHLY 
├── credit_type        → SALE | LOAN 
├── rate               → tasa por período (snapshot en credits.interest_rate) 
└── active             → visible en cotizador y selector del Vendedor 

 

Diagrama de Entidad-Relación (DER) 

El siguiente diagrama muestra el modelo de datos normalizado en Tercera Forma Normal (3FN) que sustenta el sistema. Incluye las dieciséis entidades identificadas y sus relaciones, con tipos de datos, claves primarias (PK) y foráneas (FK). 

system_config es una tabla  esencial. Guarda todos los parámetros configurables por el Admin: tasa de comisión, días de gracia de mora, tope de mora, monto mínimo y máximo del cotizador, expiración de JWT, intentos de login, día de cierre del ciclo semanal, tasa de interes y día de pago. Así el Admin puede cambiar por ejemplo la tasa de mora sin tocar el código. 

 

 

 

 

 

Entidades del modelo 

Entidad 

Descripción 

USER 

Usuarios internos del sistema (Admin, Vendedor, Cobrador) 

CUSTOMER 

Clientes con créditos activos o históricos 

CREDIT 

Operación crediticia: venta a crédito (SALE) o préstamo en efectivo (LOAN) 

PRODUCT 

Catálogo de productos disponibles para ventas a crédito 

CREDIT_PRODUCT 

Ítems asociados a un crédito de tipo SALE con precio histórico congelado 

INSTALLMENT 

Cuotas del cronograma de pago generadas al aprobar el crédito 

PAYMENT 

Pre-cargas de cobro registradas por el Cobrador, aprobadas por el Admin 

CASH_REGISTER 

Registro de cierre de caja diario con desglose y diferencia 

COLLECTION_SHEET 

Planilla de cobro emitida por el Admin para cada Cobrador 

COLLECTION_SHEET_DETAIL 

Detalle de cuotas incluidas en cada planilla con orden de recorrido 

TOKEN_BLACKLIST 

Tokens JWT revocados para cierre de sesión y cambio de rol 

SALARY 

Registra el sueldo fijo de cada empleado 

COMMISSION 

Registra las comisiones por ventas 

COMMISSION_LIQUIDATION 

Regista liquidacion de salarios y/o comisiones 

SYSTEM_CONFIG 

Registra configuraciones del sistema 

INTEREST_RATE 

Registra la configuracion de intereses 

 

 

 
 te explico, tuve una reunion con el cliente y cambio el caso de uso de creditos tipo SALE.
ya que manejan 3 posibilidades:
1. el curso normal. donde la venta se produce el sistema calcula las cuotas y listo
2. el cliente adelanta una o mas cuotas. en donde el sistema debe permitirlo y correr las fechas del proximo pago de cuota
3. que el cliente de un adelanto del total del credito. en ese caso las cuotas se calculan del saldo.
para eso cree la rama. para hacer los cambios ahi y no tocar main. tampoco quiero realizar cambios en la base de datos local. sino hacer otra de ser posible
Decisiones de diseño confirmadas
1. Tasas por producto (product_rates)
Tabla nueva separada de interest_rates. Cada producto tiene su propia matriz de coeficientes por frecuencia y cantidad de cuotas. La tabla interest_rates queda exclusivamente para LOAN.
2. Adelanto de cuotas

Flujo normal de doble control: Cobrador registra → Admin aprueba.
Al aprobar, el sistema marca las cuotas adelantadas como PAID con nota "Pago adelantado".
Las cuotas restantes se recorren: si la cuota 1 vencía el 16/05 y se adelanta, la cuota 2 pasa a vencer el 16/05, la 3 el 16/06, y así sucesivamente.
Las fechas originales se guardan en installments.original_due_date para auditoría.

3. Adelanto de dinero al momento de la venta (enganche)

El Vendedor lo ingresa al crear el crédito.
Reduce el capital: capital_del_credito = precio_producto - down_payment.
Impacta en caja como ingreso del día (tipo DOWN_PAYMENT).
credits — cambios en create y approve
Al crear SALE: el Vendedor puede enviar down_payment opcional. El sistema lo guarda y calcula capital = total_amount - down_payment.
Al aprobar SALE: en lugar de buscar en interest_rates, busca en product_rates usando product_id + payment_frequency + installments_count. Si el crédito tiene down_payment > 0, genera además un payment de tipo DOWN_PAYMENT ya aprobado, que impacta en caja.
payments — nuevo flujo para adelanto de cuotas
Cuando el Cobrador registra un pago que cubre más de una cuota (o cuando el Admin va a aprobar múltiples cuotas), el sistema detecta que el monto supera la cuota actual y ofrece aplicar el excedente a las siguientes cuotas.
Al aprobar, si hay cuotas adelantadas:

Marca las cuotas cubiertas como PAID con notes: "Pago adelantado"
Recorre las fechas de las cuotas restantes
cashRegister — el enganche aparece en el dashboard del día
El getDashboard() y el close() van a incluir los pagos de tipo DOWN_PAYMENT en el total recaudado del día.
Comisión = precio completo × 8% (sin importar el enganche)
Enganche reduce el capital del crédito pero no la comisión
Tasas de productos en tabla product_rates separada
Adelanto de cuotas corre fechas hacia adelante
los adelantos pueden ser en CASH O TRANSFER

Aspectointerest_ratesproduct_ratesAplica aLOAN (préstamos)SALE (ventas de productos)Filtro de montoSí (min/max_amount)No (precio fijo del producto)Administrado porAdmin desde panelAdmin desde el productoLookup al aprobarPor frecuencia + cuotas + montoPor producto + frecuencia + cuotas

Cómo queda el flujo completo para SALE
Vendedor selecciona producto + frecuencia + cuotas
        ↓
Sistema consulta product_rates → obtiene el coeficiente
        ↓
Cotizador muestra: cuota = Math.ceil(precio × (1 + rate) / n / 1000) × 1000
        ↓
Admin aprueba → se guarda historical_rate en credit_products
        ↓
Las cuotas se generan con ese coeficiente congelado