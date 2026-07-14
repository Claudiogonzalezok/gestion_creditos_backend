const swaggerSpec = {
  openapi: '3.0.3',
  info: {
    title: 'API — Sistema de Gestión de Créditos',
    version: '1.0.0',
    description:
      'API REST para el sistema de gestión de préstamos personales y ventas a crédito. ' +
      'Usa dos esquemas JWT independientes: uno para el sistema interno (Admin/Vendedor/Cobrador) ' +
      'y otro para el portal público de clientes.',
  },
  servers: [{ url: '/api', description: 'Base URL' }],

  // ── Seguridad ────────────────────────────────────────────────
  components: {
    securitySchemes: {
      internalAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT del sistema interno (Admin, Vendedor, Cobrador)',
      },
      portalAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token JWT del portal público (Cliente)',
      },
    },

    // ── Respuestas reutilizables ─────────────────────────────
    responses: {
      Unauthorized:  { description: 'Token inválido o sesión expirada' },
      Forbidden:     { description: 'Sin permisos para esta operación' },
      NotFound:      { description: 'Recurso no encontrado' },
      Conflict:      { description: 'Conflicto con el estado actual del recurso' },
      ServerError:   { description: 'Error interno del servidor' },
    },

    // ── Schemas reutilizables ────────────────────────────────
    schemas: {
      UUID: { type: 'string', format: 'uuid', example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
      Date: { type: 'string', format: 'date', example: '2026-05-03' },
      PaymentMethod: { type: 'string', enum: ['CASH', 'TRANSFER'] },
      PaymentFrequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'] },
      CreditType: { type: 'string', enum: ['SALE', 'LOAN'] },
      Ok: {
        type: 'object',
        properties: {
          ok:      { type: 'boolean', example: true },
          message: { type: 'string' },
          data:    { type: 'object' },
        },
      },
    },
  },

  // ── Tags (agrupación en la UI) ───────────────────────────────
  tags: [
    { name: 'Auth',               description: 'Autenticación — sistema interno y portal' },
    { name: 'Users',              description: 'Gestión de usuarios internos (CU02)' },
    { name: 'Customers',          description: 'Gestión de clientes (CU03)' },
    { name: 'Products',           description: 'Catálogo de productos (CU04)' },
    { name: 'Product Brands',     description: 'Marcas de productos' },
    { name: 'Product Categories', description: 'Categorías de productos' },
    { name: 'Product Variants',   description: 'Variantes de producto (color, talle, capacidad)' },
    { name: 'Product Units',      description: 'Unidades individuales de stock' },
    { name: 'Product Rates',      description: 'Tasas de interés por producto (SALE)' },
    { name: 'Interest Rates',     description: 'Tasas de interés para préstamos (LOAN)' },
    { name: 'Credits',            description: 'Créditos — pre-ventas, pre-préstamos y aprobación (CU05/CU08)' },
    { name: 'Installments',       description: 'Cuotas y mora (CU13)' },
    { name: 'Payments',           description: 'Pre-cargas de cobro y aprobación (CU07/CU09)' },
    { name: 'Collections',        description: 'Planillas de cobro (CU14)' },
    { name: 'Commissions',        description: 'Comisiones y liquidaciones (CU15)' },
    { name: 'Cash Register',      description: 'Caja diaria y cierres (CU12)' },
    { name: 'Expenses',           description: 'Egresos / gastos operativos' },
    { name: 'Expense Categories', description: 'Categorías de egresos' },
    { name: 'Reports',            description: 'Reportes (CU12)' },
    { name: 'System Config',      description: 'Configuración de parámetros del sistema (CU16)' },
    { name: 'Holidays',           description: 'Feriados y ajustes de vencimientos por día hábil' },
    { name: 'Portal',             description: 'Portal público — estado de cuenta del cliente (CU11)' },
  ],

  paths: {

    // ════════════════════════════════════════════════════════════
    // AUTH
    // ════════════════════════════════════════════════════════════
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login sistema interno',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['dni', 'password'],
                properties: {
                  dni:      { type: 'string', example: '12345678' },
                  password: { type: 'string', example: 'MiPassword1' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Login exitoso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok:      { type: 'boolean' },
                    message: { type: 'string' },
                    data: {
                      type: 'object',
                      properties: {
                        token: { type: 'string' },
                        user: {
                          type: 'object',
                          properties: {
                            id:               { type: 'string', format: 'uuid' },
                            full_name:        { type: 'string' },
                            role:             { type: 'string', enum: ['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'] },
                            is_temp_password: { type: 'boolean' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout sistema interno',
        security: [{ internalAuth: [] }],
        responses: {
          200: { description: 'Sesión cerrada' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Usuario autenticado actual',
        description: 'Para rol ADMIN incluye `pending_approvals_count`.',
        security: [{ internalAuth: [] }],
        responses: {
          200: {
            description: 'Datos del usuario',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        id:                     { type: 'string', format: 'uuid' },
                        full_name:              { type: 'string' },
                        role:                   { type: 'string' },
                        status:                 { type: 'string' },
                        is_temp_password:       { type: 'boolean' },
                        pending_approvals_count:{ type: 'integer', description: 'Solo para ADMIN' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/auth/portal/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login portal público (clientes)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['dni', 'password'],
                properties: {
                  dni:      { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Login exitoso — retorna token de portal' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/auth/portal/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout portal público',
        security: [{ portalAuth: [] }],
        responses: {
          200: { description: 'Sesión cerrada' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/holidays': {
      get: {
        tags: ['Holidays'],
        summary: 'Listar feriados',
        security: [{ internalAuth: [] }],
        responses: {
          200: { description: 'Listado de feriados' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Holidays'],
        summary: 'Crear feriado (opcionalmente recalcula cuotas futuras)',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['date', 'name', 'type'],
                properties: {
                  date: { $ref: '#/components/schemas/Date' },
                  name: { type: 'string', example: 'Feriado extraordinario provincial' },
                  type: { type: 'string', enum: ['EXTRAORDINARY', 'NATIONAL', 'LOCAL', 'BANKING'] },
                  affects_due_dates: { type: 'boolean', example: true },
                  active: { type: 'boolean', example: true },
                  repeats_annually: { type: 'boolean', example: false },
                  recalculateFutureInstallments: { type: 'boolean', example: true },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Feriado creado' },
          409: { $ref: '#/components/responses/Conflict' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/holidays/{id}': {
      get: {
        tags: ['Holidays'],
        summary: 'Obtener feriado por ID',
        security: [{ internalAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        ],
        responses: {
          200: { description: 'Feriado encontrado' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Holidays'],
        summary: 'Actualizar feriado',
        security: [{ internalAuth: [] }],
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['EXTRAORDINARY', 'NATIONAL', 'LOCAL', 'BANKING'] },
                  affects_due_dates: { type: 'boolean' },
                  active: { type: 'boolean' },
                  repeats_annually: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Feriado actualizado' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/holidays/duplicate-year': {
      post: {
        tags: ['Holidays'],
        summary: 'Duplicar feriados elegibles al próximo año',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceYear'],
                properties: {
                  sourceYear: { type: 'integer', example: 2026 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Duplicación ejecutada con resumen' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    '/holidays/duplicate-year/preview': {
      post: {
        tags: ['Holidays'],
        summary: 'Previsualizar duplicación anual de feriados',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sourceYear'],
                properties: {
                  sourceYear: { type: 'integer', example: 2026 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Vista previa de duplicación sin escritura' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
    },

    // ════════════════════════════════════════════════════════════
    // USERS
    // ════════════════════════════════════════════════════════════
    '/users/me/change-password': {
      patch: {
        tags: ['Users'],
        summary: 'Cambiar contraseña propia',
        description: 'Disponible con contraseña temporal (allowTemp).',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['current_password', 'new_password'],
                properties: {
                  current_password: { type: 'string' },
                  new_password:     { type: 'string', minLength: 8, maxLength: 100 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Contraseña actualizada' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },

    '/users': {
      get: {
        tags: ['Users'],
        summary: 'Listar usuarios',
        security: [{ internalAuth: [] }],
        parameters: [
          { name: 'role',   in: 'query', schema: { type: 'string', enum: ['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['ACTIVE','INACTIVE'] } },
        ],
        responses: {
          200: { description: 'Lista de usuarios' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Users'],
        summary: 'Crear usuario',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['full_name', 'dni', 'role'],
                properties: {
                  full_name: { type: 'string', minLength: 3, maxLength: 150 },
                  dni:       { type: 'string', pattern: '^[0-9]{7,9}$' },
                  email:     { type: 'string', format: 'email' },
                  address:   { type: 'string', maxLength: 255 },
                  role:      { type: 'string', enum: ['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'] },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Usuario creado — retorna contraseña temporal' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },

    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Obtener usuario por ID',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: {
          200: { description: 'Datos del usuario' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Users'],
        summary: 'Actualizar usuario',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  full_name: { type: 'string', minLength: 3, maxLength: 150 },
                  dni:       { type: 'string', pattern: '^[0-9]{7,9}$' },
                  email:     { type: 'string', format: 'email' },
                  address:   { type: 'string', maxLength: 255 },
                  role:      { type: 'string', enum: ['ADMIN','SELLER','COLLECTOR','SELLER_COLLECTOR'] },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Usuario actualizado' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    '/users/{id}/deactivate': {
      patch: {
        tags: ['Users'],
        summary: 'Desactivar usuario',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Usuario desactivado' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/users/{id}/activate': {
      patch: {
        tags: ['Users'],
        summary: 'Reactivar usuario',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Usuario activado' } },
      },
    },

    '/users/{id}/reset-password': {
      patch: {
        tags: ['Users'],
        summary: 'Resetear contraseña (genera contraseña temporal)',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Contraseña temporal generada y retornada' } },
      },
    },

    '/users/{id}/unlock': {
      patch: {
        tags: ['Users'],
        summary: 'Desbloquear cuenta de usuario',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Cuenta desbloqueada' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // CUSTOMERS
    // ════════════════════════════════════════════════════════════
    '/customers': {
      get: {
        tags: ['Customers'],
        summary: 'Listar clientes',
        security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',       in: 'query', schema: { type: 'string', enum: ['ACTIVE','INACTIVE'] } },
          { name: 'collector_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        ],
        responses: { 200: { description: 'Lista de clientes' } },
      },
      post: {
        tags: ['Customers'],
        summary: 'Crear cliente',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['full_name', 'dni'],
                properties: {
                  full_name:            { type: 'string', minLength: 3, maxLength: 150 },
                  dni:                  { type: 'string', pattern: '^[0-9]{7,9}$' },
                  phone:                { type: 'string', minLength: 6, maxLength: 30 },
                  email:                { type: 'string', format: 'email' },
                  address:              { type: 'string', maxLength: 255 },
                  assigned_collector_id:{ $ref: '#/components/schemas/UUID' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Cliente creado' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/customers/{id}': {
      get: {
        tags: ['Customers'],
        summary: 'Obtener cliente por ID',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Datos del cliente' }, 404: { $ref: '#/components/responses/NotFound' } },
      },
      put: {
        tags: ['Customers'],
        summary: 'Actualizar cliente',
        security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  full_name:            { type: 'string', minLength: 3, maxLength: 150 },
                  phone:                { type: 'string' },
                  email:                { type: 'string', format: 'email' },
                  address:              { type: 'string', maxLength: 255 },
                  assigned_collector_id:{ $ref: '#/components/schemas/UUID' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Cliente actualizado' } },
      },
    },

    '/customers/{id}/deactivate':         { patch: { tags: ['Customers'], summary: 'Desactivar cliente',                   security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' }, 409: { $ref: '#/components/responses/Conflict' } } } },
    '/customers/{id}/activate':           { patch: { tags: ['Customers'], summary: 'Reactivar cliente',                    security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/customers/{id}/enable-portal':      { patch: { tags: ['Customers'], summary: 'Habilitar acceso al portal',           security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/customers/{id}/disable-portal':     { patch: { tags: ['Customers'], summary: 'Deshabilitar acceso al portal',        security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/customers/{id}/reset-portal-password': { patch: { tags: ['Customers'], summary: 'Resetear contraseña del portal', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'Contraseña temporal generada' } } } },
    '/customers/{id}/unlock-portal':      { patch: { tags: ['Customers'], summary: 'Desbloquear acceso al portal',        security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCTS
    // ════════════════════════════════════════════════════════════
    '/products': {
      get: {
        tags: ['Products'],
        summary: 'Listar productos',
        security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',      in: 'query', schema: { type: 'string', enum: ['ACTIVE','INACTIVE'] } },
          { name: 'category_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'search',      in: 'query', schema: { type: 'string', maxLength: 100 } },
        ],
        responses: { 200: { description: 'Lista de productos' } },
      },
      post: {
        tags: ['Products'],
        summary: 'Crear producto',
        security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title:       { type: 'string', minLength: 2, maxLength: 150 },
                  description: { type: 'string', maxLength: 500 },
                  model:       { type: 'string', maxLength: 100 },
                  brand_id:    { $ref: '#/components/schemas/UUID' },
                  category_id: { $ref: '#/components/schemas/UUID' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Producto creado' } },
      },
    },

    '/products/{id}': {
      get:  { tags: ['Products'], summary: 'Obtener producto por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' }, 404: { $ref: '#/components/responses/NotFound' } } },
      put:  {
        tags: ['Products'], summary: 'Actualizar producto', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, model: { type: 'string' }, brand_id: { $ref: '#/components/schemas/UUID' }, category_id: { $ref: '#/components/schemas/UUID' } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/products/{id}/deactivate': { patch: { tags: ['Products'], summary: 'Desactivar producto', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/products/{id}/activate':   { patch: { tags: ['Products'], summary: 'Reactivar producto',  security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCT BRANDS
    // ════════════════════════════════════════════════════════════
    '/product-brands': {
      get:  { tags: ['Product Brands'], summary: 'Listar marcas', security: [{ internalAuth: [] }], responses: { 200: { description: 'Lista de marcas' } } },
      post: {
        tags: ['Product Brands'], summary: 'Crear marca', security: [{ internalAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 100 } } } } } },
        responses: { 201: { description: 'Marca creada' } },
      },
    },

    '/product-brands/{id}': {
      get: { tags: ['Product Brands'], summary: 'Obtener marca por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      put: {
        tags: ['Product Brands'], summary: 'Actualizar marca', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 100 } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/product-brands/{id}/deactivate': { patch: { tags: ['Product Brands'], summary: 'Desactivar marca', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/product-brands/{id}/activate':   { patch: { tags: ['Product Brands'], summary: 'Reactivar marca',  security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCT CATEGORIES
    // ════════════════════════════════════════════════════════════
    '/product-categories': {
      get:  { tags: ['Product Categories'], summary: 'Listar categorías de productos', security: [{ internalAuth: [] }], responses: { 200: { description: 'Lista de categorías' } } },
      post: {
        tags: ['Product Categories'], summary: 'Crear categoría', security: [{ internalAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 100 } } } } } },
        responses: { 201: { description: 'Categoría creada' } },
      },
    },

    '/product-categories/{id}': {
      put: {
        tags: ['Product Categories'], summary: 'Actualizar categoría', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 100 } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/product-categories/{id}/activate':   { patch: { tags: ['Product Categories'], summary: 'Activar categoría',   security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/product-categories/{id}/deactivate': { patch: { tags: ['Product Categories'], summary: 'Desactivar categoría', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCT VARIANTS
    // ════════════════════════════════════════════════════════════
    '/product-variants': {
      get: {
        tags: ['Product Variants'], summary: 'Listar variantes', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'product_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'status',     in: 'query', schema: { type: 'string', enum: ['ACTIVE','INACTIVE'] } },
        ],
        responses: { 200: { description: 'Lista de variantes' } },
      },
      post: {
        tags: ['Product Variants'], summary: 'Crear variante', security: [{ internalAuth: [] }],
        description: 'Al menos uno de color, size o capacity es requerido.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['product_id', 'current_price'],
                properties: {
                  product_id:    { $ref: '#/components/schemas/UUID' },
                  color:         { type: 'string', maxLength: 50 },
                  size:          { type: 'string', maxLength: 50 },
                  capacity:      { type: 'string', maxLength: 50 },
                  current_price: { type: 'number', minimum: 0.01 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Variante creada' } },
      },
    },

    '/product-variants/{id}': {
      get: { tags: ['Product Variants'], summary: 'Obtener variante por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      put: {
        tags: ['Product Variants'], summary: 'Actualizar variante', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { color: { type: 'string' }, size: { type: 'string' }, capacity: { type: 'string' }, current_price: { type: 'number', minimum: 0.01 } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/product-variants/{id}/deactivate': { patch: { tags: ['Product Variants'], summary: 'Desactivar variante', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/product-variants/{id}/activate':   { patch: { tags: ['Product Variants'], summary: 'Reactivar variante',  security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCT UNITS
    // ════════════════════════════════════════════════════════════
    '/product-units': {
      get: {
        tags: ['Product Units'], summary: 'Listar unidades de stock', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'variant_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'product_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'status',     in: 'query', schema: { type: 'string', enum: ['AVAILABLE','RESERVED','SOLD','INACTIVE'] } },
        ],
        responses: { 200: { description: 'Lista de unidades' } },
      },
      post: {
        tags: ['Product Units'], summary: 'Registrar unidad individual', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['variant_id', 'unit_code'],
                properties: {
                  variant_id: { $ref: '#/components/schemas/UUID' },
                  unit_code:  { type: 'string', minLength: 2, maxLength: 100, pattern: '^[a-zA-Z0-9_-]+$' },
                  notes:      { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Unidad creada' } },
      },
    },

    '/product-units/bulk': {
      post: {
        tags: ['Product Units'], summary: 'Registrar múltiples unidades (bulk)', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['variant_id', 'units'],
                properties: {
                  variant_id: { $ref: '#/components/schemas/UUID' },
                  units: {
                    type: 'array', minItems: 1,
                    items: {
                      type: 'object',
                      required: ['unit_code'],
                      properties: {
                        unit_code: { type: 'string', minLength: 2, maxLength: 100 },
                        notes:     { type: 'string', maxLength: 500 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Unidades creadas — retorna cantidad y lista' } },
      },
    },

    '/product-units/{id}': {
      get:   { tags: ['Product Units'], summary: 'Obtener unidad por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      patch: {
        tags: ['Product Units'], summary: 'Actualizar unidad', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { unit_code: { type: 'string' }, notes: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/product-units/{id}/deactivate': { patch: { tags: ['Product Units'], summary: 'Dar de baja unidad (OUT de stock)', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/product-units/{id}/activate':   { patch: { tags: ['Product Units'], summary: 'Reactivar unidad',                  security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // PRODUCT RATES
    // ════════════════════════════════════════════════════════════
    '/product-rates': {
      get: {
        tags: ['Product Rates'], summary: 'Listar tasas de productos', security: [{ internalAuth: [] }],
        parameters: [{ name: 'product_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Lista de tasas' } },
      },
      post: {
        tags: ['Product Rates'], summary: 'Crear tasa de producto', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['product_id', 'payment_frequency', 'installments_count', 'rate'],
                properties: {
                  product_id:        { $ref: '#/components/schemas/UUID' },
                  payment_frequency: { $ref: '#/components/schemas/PaymentFrequency' },
                  installments_count:{ type: 'integer', minimum: 1, maximum: 120 },
                  rate:              { type: 'number', minimum: 0.001, maximum: 100 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Tasa creada' } },
      },
    },

    '/product-rates/{id}': {
      get: { tags: ['Product Rates'], summary: 'Obtener tasa por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      put: {
        tags: ['Product Rates'], summary: 'Actualizar tasa', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { rate: { type: 'number', minimum: 0.001 }, active: { type: 'boolean' } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/product-rates/{id}/deactivate': { patch: { tags: ['Product Rates'], summary: 'Desactivar tasa de producto', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/product-rates/{id}/activate':   { patch: { tags: ['Product Rates'], summary: 'Activar tasa de producto',   security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // INTEREST RATES
    // ════════════════════════════════════════════════════════════
    '/interest-rates': {
      get: {
        tags: ['Interest Rates'], summary: 'Listar tasas de préstamos', security: [{ internalAuth: [] }],
        parameters: [{ name: 'payment_frequency', in: 'query', schema: { $ref: '#/components/schemas/PaymentFrequency' } }],
        responses: { 200: { description: 'Lista de tasas' } },
      },
      post: {
        tags: ['Interest Rates'], summary: 'Crear tasa de préstamo', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['installments_count', 'payment_frequency', 'min_amount', 'rate'],
                properties: {
                  installments_count: { type: 'integer', minimum: 1, maximum: 120 },
                  payment_frequency:  { $ref: '#/components/schemas/PaymentFrequency' },
                  min_amount:         { type: 'number', minimum: 0 },
                  max_amount:         { type: 'number' },
                  rate:               { type: 'number', minimum: 0.001, maximum: 100 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Tasa creada' } },
      },
    },

    '/interest-rates/{id}': {
      get: { tags: ['Interest Rates'], summary: 'Obtener tasa por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      put: {
        tags: ['Interest Rates'], summary: 'Actualizar tasa', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { rate: { type: 'number', minimum: 0.001 }, active: { type: 'boolean' } } } } } },
        responses: { 200: { description: 'OK' } },
      },
    },

    '/interest-rates/{id}/deactivate': { patch: { tags: ['Interest Rates'], summary: 'Desactivar tasa', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/interest-rates/{id}/activate':   { patch: { tags: ['Interest Rates'], summary: 'Activar tasa',    security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // CREDITS
    // ════════════════════════════════════════════════════════════
    '/credits/simulate': {
      post: {
        tags: ['Credits'],
        summary: 'Simular crédito / cotizador (sin autenticación)',
        description: 'Endpoint público. Para SALE usa `products[]`; para LOAN usa `total_amount`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['type', 'installments_count', 'payment_frequency'],
                properties: {
                  type:               { $ref: '#/components/schemas/CreditType' },
                  total_amount:       { type: 'number', description: 'Requerido para LOAN' },
                  products:           {
                    type: 'array', description: 'Requerido para SALE',
                    items: {
                      type: 'object',
                      properties: {
                        variant_id: { $ref: '#/components/schemas/UUID' },
                        quantity:   { type: 'integer', minimum: 1 },
                      },
                    },
                  },
                  down_payment:       { type: 'number', minimum: 0 },
                  installments_count: { type: 'integer', minimum: 1, maximum: 120 },
                  payment_frequency:  { $ref: '#/components/schemas/PaymentFrequency' },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Resultado de la simulación' } },
      },
    },

    '/credits': {
      get: {
        tags: ['Credits'], summary: 'Listar créditos', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',      in: 'query', schema: { type: 'string', enum: ['PENDING_APPROVAL','ACTIVE','SETTLED','REJECTED','EXPIRED'] } },
          { name: 'type',        in: 'query', schema: { $ref: '#/components/schemas/CreditType' } },
          { name: 'customer_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        ],
        responses: { 200: { description: 'Lista de créditos' } },
      },
      post: {
        tags: ['Credits'], summary: 'Crear pre-venta o pre-préstamo', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['customer_id', 'type', 'installments_count', 'payment_frequency'],
                properties: {
                  customer_id:                           { $ref: '#/components/schemas/UUID' },
                  type:                                  { $ref: '#/components/schemas/CreditType' },
                  total_amount:                          { type: 'number', description: 'Requerido para LOAN' },
                  installments_count:                    { type: 'integer', minimum: 1, maximum: 120 },
                  payment_frequency:                     { $ref: '#/components/schemas/PaymentFrequency' },
                  unit_ids:                              { type: 'array', items: { $ref: '#/components/schemas/UUID' }, description: 'Requerido para SALE' },
                  down_payment:                          { type: 'number', minimum: 0 },
                  down_payment_method:                   { $ref: '#/components/schemas/PaymentMethod' },
                  down_payment_transfer_reference:       { type: 'string', maxLength: 100 },
                  prepaid_installments:                  { type: 'integer', minimum: 1, maximum: 120, description: 'Solo SALE' },
                  prepaid_installments_method:           { $ref: '#/components/schemas/PaymentMethod' },
                  prepaid_installments_transfer_reference: { type: 'string', maxLength: 100 },
                  notes:                                 { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Pre-crédito creado en estado PENDING_APPROVAL' } },
      },
    },

    '/credits/{id}': {
      get: { tags: ['Credits'], summary: 'Obtener crédito por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' }, 404: { $ref: '#/components/responses/NotFound' } } },
    },

    '/credits/{id}/approve': {
      patch: {
        tags: ['Credits'], summary: 'Aprobar pre-crédito', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { installments_count: { type: 'integer', minimum: 1, maximum: 120 } } } } } },
        responses: { 200: { description: 'Crédito aprobado — cuotas generadas' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/credits/{id}/reject': {
      patch: {
        tags: ['Credits'], summary: 'Rechazar pre-crédito', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['rejection_reason'], properties: { rejection_reason: { type: 'string', minLength: 5, maxLength: 500 } } } } } },
        responses: { 200: { description: 'Crédito rechazado' } },
      },
    },

    '/credits/{id}/early-settlement': {
      patch: {
        tags: ['Credits'], summary: 'Cancelación anticipada de crédito', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['payment_method'],
                properties: {
                  payment_method:      { $ref: '#/components/schemas/PaymentMethod' },
                  transfer_reference:  { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Crédito cancelado — estado SETTLED' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // INSTALLMENTS
    // ════════════════════════════════════════════════════════════
    '/installments': {
      get: {
        tags: ['Installments'], summary: 'Listar cuotas', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',       in: 'query', schema: { type: 'string', enum: ['PENDING','OVERDUE','PAID','PARTIAL'] } },
          { name: 'collector_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'credit_id',    in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        ],
        responses: { 200: { description: 'Lista de cuotas' } },
      },
    },

    '/installments/{id}': {
      get: { tags: ['Installments'], summary: 'Obtener cuota por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
    },

    '/installments/{id}/apply-penalty': {
      patch: {
        tags: ['Installments'], summary: 'Aplicar mora a cuota vencida', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['penalty_amount'], properties: { penalty_amount: { type: 'number', minimum: 0.01 } } } } } },
        responses: { 200: { description: 'Mora aplicada' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/installments/{id}/waive-penalty': {
      patch: {
        tags: ['Installments'], summary: 'Condonar mora de una cuota', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Mora condonada' } },
      },
    },

    '/installments/{id}/early-pay': {
      patch: {
        tags: ['Installments'], summary: 'Pago anticipado de cuota individual', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['payment_method'],
                properties: {
                  payment_method:     { $ref: '#/components/schemas/PaymentMethod' },
                  transfer_reference: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Cuota pagada anticipadamente' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // PAYMENTS
    // ════════════════════════════════════════════════════════════
    '/payments': {
      get: {
        tags: ['Payments'], summary: 'Listar pre-cargas de cobro', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',         in: 'query', schema: { type: 'string', enum: ['PENDING','APPROVED','REJECTED'] } },
          { name: 'collector_id',   in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'installment_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
        ],
        responses: { 200: { description: 'Lista de cobros' } },
      },
      post: {
        tags: ['Payments'], summary: 'Registrar pre-carga de cobro', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['installment_id', 'amount_received', 'payment_method'],
                properties: {
                  installment_id:     { $ref: '#/components/schemas/UUID' },
                  amount_received:    { type: 'number', minimum: 0.01 },
                  payment_method:     { $ref: '#/components/schemas/PaymentMethod' },
                  transfer_reference: { type: 'string', maxLength: 100 },
                  notes:              { type: 'string', maxLength: 500 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Pre-carga registrada en estado PENDING' } },
      },
    },

    '/payments/{id}': {
      get: { tags: ['Payments'], summary: 'Obtener cobro por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
    },

    '/payments/{id}/approve': {
      patch: {
        tags: ['Payments'], summary: 'Aprobar pre-carga de cobro', security: [{ internalAuth: [] }],
        description: 'Actualiza la cuota (PAID/PARTIAL) y cierra el crédito si corresponde.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Cobro aprobado' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/payments/{id}/reject': {
      patch: {
        tags: ['Payments'], summary: 'Rechazar pre-carga de cobro', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['rejection_reason'], properties: { rejection_reason: { type: 'string', minLength: 5, maxLength: 500 } } } } } },
        responses: { 200: { description: 'Cobro rechazado' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // COLLECTIONS
    // ════════════════════════════════════════════════════════════
    '/collections': {
      get: {
        tags: ['Collections'], summary: 'Listar planillas de cobro', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'collector_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'date',         in: 'query', schema: { $ref: '#/components/schemas/Date' } },
        ],
        responses: { 200: { description: 'Lista de planillas' } },
      },
      post: {
        tags: ['Collections'], summary: 'Generar planilla de cobro', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['collector_id', 'date'],
                properties: {
                  collector_id: { $ref: '#/components/schemas/UUID' },
                  date:         { $ref: '#/components/schemas/Date' },
                  filter:       { type: 'string', enum: ['TODAY','OVERDUE','TODAY_AND_OVERDUE','ALL_PENDING'] },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Planilla generada' } },
      },
    },

    '/collections/{id}': {
      get: { tags: ['Collections'], summary: 'Obtener planilla por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
    },

    // ════════════════════════════════════════════════════════════
    // COMMISSIONS
    // ════════════════════════════════════════════════════════════
    '/commissions': {
      get: {
        tags: ['Commissions'], summary: 'Listar comisiones', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'status',     in: 'query', schema: { type: 'string', enum: ['PENDING','PAID','REVERSED'] } },
          { name: 'user_id',    in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'week_start', in: 'query', schema: { $ref: '#/components/schemas/Date' } },
        ],
        responses: { 200: { description: 'Lista de comisiones' } },
      },
    },

    '/commissions/weekly-summary': {
      get: { tags: ['Commissions'], summary: 'Resumen semanal para liquidación (Admin)', security: [{ internalAuth: [] }], responses: { 200: { description: 'Resumen por empleado' } } },
    },

    '/commissions/liquidations': {
      get: {
        tags: ['Commissions'], summary: 'Historial de liquidaciones', security: [{ internalAuth: [] }],
        parameters: [{ name: 'user_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Lista de liquidaciones' } },
      },
    },

    '/commissions/liquidate': {
      post: {
        tags: ['Commissions'], summary: 'Ejecutar liquidación semanal', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['user_id', 'payment_method'],
                properties: {
                  user_id:            { $ref: '#/components/schemas/UUID' },
                  payment_method:     { $ref: '#/components/schemas/PaymentMethod' },
                  transfer_reference: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Liquidación ejecutada' } },
      },
    },

    '/commissions/salary/{userId}': {
      get: { tags: ['Commissions'], summary: 'Obtener sueldo fijo de un cobrador', security: [{ internalAuth: [] }], parameters: [{ name: 'userId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      put: {
        tags: ['Commissions'], summary: 'Actualizar sueldo fijo de un cobrador', security: [{ internalAuth: [] }],
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['weekly_amount'], properties: { weekly_amount: { type: 'number', minimum: 0 } } } } } },
        responses: { 200: { description: 'Sueldo actualizado' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // CASH REGISTER
    // ════════════════════════════════════════════════════════════
    '/cash-register/dashboard': {
      get: {
        tags: ['Cash Register'], summary: 'Dashboard de caja del día', security: [{ internalAuth: [] }],
        description: 'Incluye ingresos aprobados, pendientes, enganches y egresos. Acepta `?date=YYYY-MM-DD` para ver un día anterior.',
        parameters: [{ name: 'date', in: 'query', schema: { $ref: '#/components/schemas/Date' } }],
        responses: { 200: { description: 'Totales del día' } },
      },
    },

    '/cash-register/close': {
      post: {
        tags: ['Cash Register'], summary: 'Cerrar caja del día', security: [{ internalAuth: [] }],
        description: 'Acepta `register_date` para cierre retroactivo de días anteriores. Si hay pre-cargas pendientes, usar `force: true`.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['declared_cash'],
                properties: {
                  declared_cash:  { type: 'number', minimum: 0 },
                  register_date:  { $ref: '#/components/schemas/Date' },
                  observations:   { type: 'string', maxLength: 500 },
                  force:          { type: 'boolean', description: 'Forzar cierre con pre-cargas pendientes' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Cierre registrado' }, 409: { $ref: '#/components/responses/Conflict' } },
      },
    },

    '/cash-register': {
      get: {
        tags: ['Cash Register'], summary: 'Historial de cierres de caja', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'date_from',        in: 'query', schema: { $ref: '#/components/schemas/Date' } },
          { name: 'date_to',          in: 'query', schema: { $ref: '#/components/schemas/Date' } },
          { name: 'difference_status',in: 'query', schema: { type: 'string', enum: ['EXACT','SURPLUS','SHORTAGE'] } },
        ],
        responses: { 200: { description: 'Lista de cierres' } },
      },
    },

    '/cash-register/{id}': {
      get: {
        tags: ['Cash Register'], summary: 'Detalle de un cierre con desglose', security: [{ internalAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }],
        responses: { 200: { description: 'Cierre con breakdown de cobros, enganches, liquidaciones y gastos' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // EXPENSES
    // ════════════════════════════════════════════════════════════
    '/expenses': {
      get: {
        tags: ['Expenses'], summary: 'Listar gastos', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'date_from',   in: 'query', schema: { $ref: '#/components/schemas/Date' } },
          { name: 'date_to',     in: 'query', schema: { $ref: '#/components/schemas/Date' } },
          { name: 'category_id', in: 'query', schema: { $ref: '#/components/schemas/UUID' } },
          { name: 'page',        in: 'query', schema: { type: 'integer', minimum: 1 } },
          { name: 'limit',       in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
        ],
        responses: { 200: { description: 'Lista de gastos' } },
      },
      post: {
        tags: ['Expenses'], summary: 'Registrar gasto', security: [{ internalAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['amount', 'description', 'expense_date', 'payment_method'],
                properties: {
                  amount:             { type: 'number', minimum: 0.01 },
                  description:        { type: 'string', minLength: 2, maxLength: 500 },
                  expense_date:       { $ref: '#/components/schemas/Date' },
                  payment_method:     { $ref: '#/components/schemas/PaymentMethod' },
                  category_id:        { $ref: '#/components/schemas/UUID' },
                  transfer_reference: { type: 'string', maxLength: 100 },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Gasto registrado' } },
      },
    },

    '/expenses/{id}': {
      get:    { tags: ['Expenses'], summary: 'Obtener gasto por ID', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } },
      delete: { tags: ['Expenses'], summary: 'Eliminar gasto',       security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'Eliminado' } } },
    },

    // ════════════════════════════════════════════════════════════
    // EXPENSE CATEGORIES
    // ════════════════════════════════════════════════════════════
    '/expense-categories': {
      get:  { tags: ['Expense Categories'], summary: 'Listar categorías de gastos', security: [{ internalAuth: [] }], responses: { 200: { description: 'Lista' } } },
      post: {
        tags: ['Expense Categories'], summary: 'Crear categoría de gasto', security: [{ internalAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2, maxLength: 100 } } } } } },
        responses: { 201: { description: 'Categoría creada' } },
      },
    },

    '/expense-categories/{id}/activate':   { patch: { tags: ['Expense Categories'], summary: 'Activar categoría',   security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },
    '/expense-categories/{id}/deactivate': { patch: { tags: ['Expense Categories'], summary: 'Desactivar categoría', security: [{ internalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'OK' } } } },

    // ════════════════════════════════════════════════════════════
    // REPORTS
    // ════════════════════════════════════════════════════════════
    '/reports/collection': {
      get: {
        tags: ['Reports'], summary: 'Reporte de recaudación por período', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'date_from', in: 'query', required: true, schema: { $ref: '#/components/schemas/Date' } },
          { name: 'date_to',   in: 'query', required: true, schema: { $ref: '#/components/schemas/Date' } },
        ],
        responses: { 200: { description: 'Totales y desglose diario' } },
      },
    },

    '/reports/portfolio': {
      get: { tags: ['Reports'], summary: 'Reporte de cartera de créditos', security: [{ internalAuth: [] }], responses: { 200: { description: 'Distribución de créditos activos/liquidados/rechazados' } } },
    },

    '/reports/overdue': {
      get: { tags: ['Reports'], summary: 'Reporte de mora', security: [{ internalAuth: [] }], responses: { 200: { description: 'Cuotas vencidas con antigüedad y montos' } } },
    },

    '/reports/collectors': {
      get: {
        tags: ['Reports'], summary: 'Reporte de cobradores', security: [{ internalAuth: [] }],
        parameters: [
          { name: 'date_from', in: 'query', required: true, schema: { $ref: '#/components/schemas/Date' } },
          { name: 'date_to',   in: 'query', required: true, schema: { $ref: '#/components/schemas/Date' } },
        ],
        responses: { 200: { description: 'Efectividad y montos por cobrador' } },
      },
    },

    '/reports/products': {
      get: {
        tags: ['Reports'], summary: 'Reporte de productos vendidos y stock', security: [{ internalAuth: [] }],
        parameters: [{ name: 'stock_threshold', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Alertar productos con stock menor a este valor' }],
        responses: { 200: { description: 'Ranking de ventas y estado de stock' } },
      },
    },

    '/reports/summary': {
      get: { tags: ['Reports'], summary: 'Resumen general del negocio', security: [{ internalAuth: [] }], responses: { 200: { description: 'KPIs globales del sistema' } } },
    },

    '/reports/upcoming': {
      get: {
        tags: ['Reports'], summary: 'Cuotas próximas a vencer', security: [{ internalAuth: [] }],
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 90 }, description: 'Horizonte en días (default: 7)' }],
        responses: { 200: { description: 'Cuotas que vencen en los próximos N días' } },
      },
    },

    // ════════════════════════════════════════════════════════════
    // SYSTEM CONFIG
    // ════════════════════════════════════════════════════════════
    '/system-config': {
      get: { tags: ['System Config'], summary: 'Listar todos los parámetros del sistema', security: [{ internalAuth: [] }], responses: { 200: { description: 'Lista de parámetros clave-valor' } } },
    },

    '/system-config/{key}': {
      get: { tags: ['System Config'], summary: 'Obtener parámetro por clave', security: [{ internalAuth: [] }], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string', example: 'penalty_rate_daily' } }], responses: { 200: { description: 'OK' }, 404: { $ref: '#/components/responses/NotFound' } } },
      put: {
        tags: ['System Config'], summary: 'Actualizar valor de parámetro', security: [{ internalAuth: [] }],
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } } },
        responses: { 200: { description: 'Parámetro actualizado' } },
      },
    },

    '/system-config/{key}/reset': {
      post: { tags: ['System Config'], summary: 'Restaurar parámetro al valor por defecto', security: [{ internalAuth: [] }], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Parámetro restaurado' } } },
    },

    // ════════════════════════════════════════════════════════════
    // PORTAL PÚBLICO
    // ════════════════════════════════════════════════════════════
    '/portal/me': {
      get: { tags: ['Portal'], summary: 'Resumen de cuenta del cliente', security: [{ portalAuth: [] }], responses: { 200: { description: 'Total adeudado, cuotas al día/mora/pagas e indicador de riesgo' } } },
    },

    '/portal/credits': {
      get: { tags: ['Portal'], summary: 'Créditos activos del cliente', security: [{ portalAuth: [] }], responses: { 200: { description: 'Lista de créditos con estado' } } },
    },

    '/portal/credits/{id}': {
      get: { tags: ['Portal'], summary: 'Detalle de crédito con cronograma de cuotas', security: [{ portalAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/components/schemas/UUID' } }], responses: { 200: { description: 'Crédito con todas las cuotas' } } },
    },
  },
};

module.exports = swaggerSpec;
