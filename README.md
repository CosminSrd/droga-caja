# Bot de caja por WhatsApp

Base inicial para un bot de registro de ventas, gastos, caja y stock usando Whapi Cloud y Neon PostgreSQL.

> Este software registra operaciones y conserva trazabilidad. No está diseñado para ocultar ventas o compras. Las compras sin factura quedan marcadas como `missing` para revisarlas con un gestor.

## Requisitos

- Node.js 20+
- Cuenta Whapi Cloud con webhook HTTPS
- Base de datos Neon PostgreSQL

## Puesta en marcha

```bash
npm install
copy .env.example .env
npm run db:migrate
npm run dev
```

En PowerShell, usa `Copy-Item .env.example .env`.

Configura en `.env` todos los valores, especialmente `WHAPI_TOKEN`, `DATABASE_URL`, los dos teléfonos autorizados y `WHATSAPP_GROUP_ID`. Nunca compartas esos secretos ni los subas al repositorio.

Configura Whapi para enviar eventos `messages` a:

```text
https://TU-DOMINIO/webhook/whapi
```

El menú inicial está implementado con `POST /messages/interactive` y botones `quick_reply`, siguiendo el formato de Whapi Cloud. El webhook responde primero y procesa después para evitar reintentos por timeout.

## Próximos pasos funcionales

1. Completar los flujos de venta, gasto y cierre de caja con formularios de listas/botones.
2. Añadir operaciones SQL transaccionales que actualicen stock y ledger.
3. Generar el resumen diario completo y enviarlo al grupo.
4. Añadir permisos de administración de productos, precios, coste, stock mínimo y usuarios.
5. Añadir exportación para el gestor y pruebas de webhook.

El proveedor de WhatsApp y el alojamiento gratuito pueden imponer límites, suspensiones o cambios de disponibilidad; verifica el plan actual antes de ponerlo en producción.
