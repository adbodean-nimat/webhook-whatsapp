# Webhook de WhatsApp

Servicio Express para `GET` y `POST /whatsapp/webhook`. Conserva la verificación de Meta, el registro JSONL diario, la sincronización con Google Drive y las respuestas automáticas a mensajes entrantes. Los eventos `statuses` se agregan además a una cola local durable para enviarlos a WEP cuando se habilite la integración.

## Configuración

| Variable | Uso |
| --- | --- |
| `VERIFY_TOKEN` | Token de verificación del GET de Meta. |
| `APP_SECRET` | Secreto de la aplicación Meta para verificar `X-Hub-Signature-256`. Obligatorio por defecto y siempre en producción. |
| `ALLOW_UNSIGNED_WEBHOOKS` | Solo para pruebas locales sin firma: `true` junto con `NODE_ENV=development` o `test`. Nunca configurar en Render. |
| `WHATSAPP_TOKEN`, `WABA_PHONE_ID` | Envío de respuestas automáticas por Graph API. |
| `VENTAS_NUMBER_E164`, `HILDA_NUMBER_E164` | Contactos usados en las derivaciones existentes. |
| `WEP_HABILITAR` | `false` por defecto: solo registra estados en JSONL y no llama a WEP, aunque haya URL. Cambiar a `true` cuando el endpoint WEP esté publicado y probado. |
| `WEP_STATUS_URL` | URL **HTTPS** del endpoint de WEP, definida por el equipo de WEP. Obligatoria cuando `WEP_HABILITAR=true`. |
| `WEP_STATUS_TOKEN` | Token Bearer servidor a servidor. Obligatorio cuando `WEP_HABILITAR=true`. |
| `LOG_LOCAL_DIR` | Carpeta de los JSONL diarios. Por defecto `/tmp/nimat-logs`. Para WEP en producción debe apuntar a un disco persistente montado en Render, por ejemplo `/var/data/nimat-logs`. |
| `WEP_STATUS_PERSISTENCE` | En producción con WEP, fijar a `render-disk` tras configurar el disco persistente. Es una declaración de configuración; el servicio no puede comprobar que Render realmente montó ese disco. |
| `DRIVE_SYNC_ENABLED`, `DRIVE_SYNC_INTERVAL_MS`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | Sincronización existente a Drive. |

No colocar tokens en el repositorio ni en comandos de prueba compartidos. Usar las variables secretas de Render. Configurar `NODE_ENV=production` en Render. Si falta `APP_SECRET`, o si WEP está activado sin URL, token o disco persistente declarado fuera de `/tmp`, el proceso no inicia. Para pruebas locales sin firma hay que habilitar expresamente `ALLOW_UNSIGNED_WEBHOOKS=true` en desarrollo/test.

Mientras WEP no tenga receptor publicado, dejar `WEP_HABILITAR=false` (o sin definir). El servicio seguirá recibiendo webhooks de Meta y sincronizando los JSONL a Drive. Si se quiere garantizar el reproceso de **todos** los estados recibidos durante esta etapa, montar el disco persistente y configurar `LOG_LOCAL_DIR` desde ahora: `/tmp` más la sincronización periódica de Drive puede perder los últimos eventos ante un reinicio. Cuando WEP esté listo, configurar URL, token y `WEP_STATUS_PERSISTENCE=render-disk`, y luego cambiar `WEP_HABILITAR=true`. Al iniciar, la cola enviará los estados pendientes de los JSONL locales; los históricos que estén solo en Drive requieren la descarga manual indicada abajo.

## Contrato que debe implementar WEP

WEP debe exponer una URL HTTPS elegida por su equipo. Este repositorio no define una URL de producción. La solicitud exacta es:

```http
POST <WEP_STATUS_URL>
Authorization: Bearer <WEP_STATUS_TOKEN>
Content-Type: application/json
Idempotency-Key: <SHA-256 hexadecimal del JSON enviado>

{"messageId":"wamid...","status":"delivered","timestamp":"1700000000"}
```

`messageId` es `st.id` y permite buscar `public.notificaciones.message_id`. `status` es uno de `sent`, `delivered`, `read`, `failed`. `timestamp` es el valor original de Meta, normalmente una cadena con segundos Unix. Solo si Meta incluye `st.errors[0].code`, se agrega `metaErrorCode` con ese valor. No se envían destinatarios, teléfonos, texto ni el webhook completo.

WEP debe validar el Bearer token y responder **200** o **204** únicamente después de guardar el evento o reconocer su `Idempotency-Key` como ya procesado. Cualquier otra respuesta o error de red queda pendiente para reintento. WEP debe hacer idempotente la combinación de `messageId`, `status`, `timestamp` y `metaErrorCode` (también se entrega el hash en la cabecera). Si el `messageId` todavía no existe en `public.notificaciones`, WEP debe guardar el evento pendiente y asociarlo después; no debe descartarlo con una respuesta exitosa.

Los estados pueden repetirse y llegar fuera de orden. Para el estado actual, WEP debe conservar el mayor avance `sent < delivered < read`; una llegada tardía de `sent` o `delivered` no debe bajar `read`. `failed` debe registrarse como evento y error, y solo establecer el estado actual como fallido si aún no se registró `delivered` o `read`. Si después llega `delivered` o `read`, ese avance prevalece. WEP puede usar el historial de eventos para auditoría.

## Persistencia y reintentos

Cada estado recibido se escribe en el JSONL diario y se confirma con `fsync` antes de responder 200 a Meta. La cola lee todos los archivos `waba-events-YYYYMMDD.jsonl` al iniciar y reintenta los estados sin confirmación. Al recibir 200/204 de WEP, escribe un registro `wep_status_ack` durable. Los duplicados de Meta se reducen a una sola entrega pendiente mediante el hash; el mismo hash se usa como clave de idempotencia en WEP. El reintento usa espera exponencial hasta cinco minutos y continúa tras reinicios. Un error de escritura del estado responde 503 a Meta **antes** de procesar los mensajes entrantes del mismo webhook; así ese reintento no repite respuestas automáticas ya enviadas.

La garantía tras reinicios requiere el disco persistente de Render montado en `LOG_LOCAL_DIR`. La configuración predeterminada `/tmp` y la sincronización periódica a Drive **no** bastan: un reinicio puede ocurrir antes de la siguiente subida. Drive sigue siendo copia del JSONL actual, pero no reemplaza el disco para la cola. Un evento enviado a WEP y todavía sin `wep_status_ack` puede reenviarse tras un reinicio; por eso WEP debe ser idempotente. Esta implementación asume una sola instancia del servicio escribiendo en ese disco. Si se necesitan varias instancias, migrar la cola a una base de datos o broker compartido con bloqueo transaccional.

Para históricos guardados solo en Drive, descargar los JSONL necesarios a `LOG_LOCAL_DIR` **con el servicio detenido** y ejecutar:

```sh
npm run replay:statuses -- --all
```

El comando requiere `WEP_HABILITAR=true`, URL y token de WEP; examina todos los JSONL locales y hace un intento de entrega de los estados únicos sin `wep_status_ack`. No procesa registros `message` ni llama a WhatsApp. Devuelve código 1 si quedan pendientes. Después se puede iniciar el servicio, que seguirá reintentando. No editar líneas JSONL; una línea inválida detiene el arranque/reproceso para revisión en vez de omitir un posible estado.

## Pruebas

```sh
npm test
```

Las pruebas usan un receptor falso y archivos temporales: cubren contrato y autenticación, duplicados, orden inverso, caída temporal de WEP, reinicio/reproceso, y firma inválida. Para una prueba local del webhook real, configurar las variables de desarrollo, enviar un cuerpo firmado con el `APP_SECRET` de prueba a `POST /whatsapp/webhook`, y comprobar en el receptor de prueba que llega solo el JSON mínimo. No apuntar esa prueba a una URL de producción.
