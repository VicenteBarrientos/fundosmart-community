(function installOfflineCapture(global) {
  "use strict";

  const DB_NAME = "fundosmart-offline";
  const DB_VERSION = 3;
  const STORES = { mutations: "mutations", readModels: "readModels", sessions: "sessions", attachments: "attachments" };
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
  const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
  const LIVESTOCK_ENTITIES = new Set(["livestock_weighing", "livestock_health", "livestock_estrus", "livestock_movement"]);

  function createRuntime(dependencies) {
    const options = dependencies || {};
    const idb = options.indexedDB || global.indexedDB;
    const fetcher = options.fetch || global.fetch.bind(global);
    const navigatorValue = options.navigator || global.navigator;
    const FormDataValue = options.FormData || global.FormData;
    const now = options.now || (() => Date.now());
    const randomBytes = options.randomBytes || (() => global.crypto.getRandomValues(new Uint8Array(10)));
    const contexts = new Map();

    function createId() {
      let timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281_474_976_710_655) throw new TypeError("La fecha local no es válida.");
      let encodedTime = "";
      for (let index = 0; index < 10; index += 1) {
        encodedTime = CROCKFORD[timestamp % 32] + encodedTime;
        timestamp = Math.floor(timestamp / 32);
      }
      const random = randomBytes();
      if (!(random instanceof Uint8Array) || random.byteLength !== 10) throw new TypeError("No fue posible crear una identidad local segura.");
      let bits = 0;
      let buffer = 0;
      let encodedRandom = "";
      for (const byte of random) {
        buffer = (buffer << 8) | byte;
        bits += 8;
        while (bits >= 5) {
          bits -= 5;
          encodedRandom += CROCKFORD[(buffer >>> bits) & 31];
          buffer &= (1 << bits) - 1;
        }
      }
      return encodedTime + encodedRandom;
    }

    async function loadContexts() {
      contexts.clear();
      const stored = await getAll(STORES.sessions);
      const valid = [];
      for (const record of stored) {
        try {
          const session = validateSession(record && record.session, record && record.scope);
          for (const fieldId of session.fieldIds) {
            const partition = normalizePartition({
              accountMode: session.accountMode,
              organizationId: session.organizationId,
              userSubject: session.userSubject,
              fieldId,
            });
            valid.push({ scope: record.scope, session, partition });
          }
        } catch {
          // Malformed or legacy sessions never authorize cold-start capture.
        }
      }
      valid.sort((left, right) => (left.scope + left.partition.fieldId).localeCompare(right.scope + right.partition.fieldId));
      for (const [index, context] of valid.entries()) {
        const key = `local-context-${index + 1}`;
        contexts.set(key, context);
        context.key = key;
        context.label = `Cuenta local ${index + 1} · Fundo ${index + 1}`;
      }
      return valid.map(publicContext);
    }

    async function readContext(key) {
      const context = contexts.get(key);
      if (!context) throw new Error("Selecciona una cuenta local y un fundo antes de continuar.");
      const reference = await getValue(STORES.readModels, readModelKey(context.partition, "livestock-field-reference-v1"));
      const geographic = await getValue(STORES.readModels, readModelKey(context.partition, "paddock-geography-v1"));
      return {
        context: publicContext(context),
        reference: validReference(reference, context.partition) ? reference.value : null,
        geographic: validGeographic(geographic, context.partition) ? geographic.value : null,
      };
    }

    async function queueLivestockCapture(input) {
      const context = captureContext(input.contextKey);
      const model = await readContext(input.contextKey);
      if (!model.reference) throw new Error("Abre Terreno con señal una vez para preparar el inventario local.");
      if (!LIVESTOCK_ENTITIES.has(input.entity)) throw new Error("La captura solicitada no está habilitada sin señal.");
      const reference = model.reference;
      const animal = reference.animals.find((entry) => entry.id === input.animalId && entry.status === "active");
      if (!animal) throw new Error("El animal no pertenece al inventario activo de este fundo.");
      if (input.entity === "livestock_estrus" && animal.sex !== "female") throw new Error("El celo sólo puede registrarse para una hembra.");
      const mutationId = createId();
      const attachmentId = input.file ? createId() : null;
      const entityId = input.entity + ":" + mutationId;
      const payload = livestockPayload(input, reference, animal, attachmentId);
      const mutation = {
        id: mutationId,
        fieldId: context.partition.fieldId,
        entity: input.entity,
        entityId,
        op: "append",
        payload,
        clientTs: isoNow(),
        expectedVersion: null,
      };
      await queueMutation(context, mutation, captureLabel(input.entity));
      if (input.file && attachmentId) await queueAttachment(context, attachmentId, entityId, input.file);
      return { mutationId, entityId, attachmentId };
    }

    async function queueLandmark(input) {
      const context = captureContext(input.contextKey);
      const model = await readContext(input.contextKey);
      if (!model.geographic || model.geographic.fieldId !== context.partition.fieldId) {
        throw new Error("Abre Potreros con señal una vez para preparar la capa geográfica local.");
      }
      const latitude = Number(input.latitude);
      const longitude = Number(input.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new Error("La coordenada debe estar dentro de WGS84.");
      }
      const kinds = new Set(["bebedero", "porton", "sala_ordena", "bodega", "manga", "cerco_electrico", "callejon", "linea_agua", "otro"]);
      if (!kinds.has(input.kind)) throw new Error("El tipo de hito no está permitido.");
      const mutationId = createId();
      const entityId = createId();
      const mutation = {
        id: mutationId,
        fieldId: context.partition.fieldId,
        entity: "field_landmark",
        entityId,
        op: "create",
        payload: {
          action: "upsert",
          kind: input.kind,
          geometryType: "point",
          geometry: [[latitude, longitude]],
          name: requiredText(input.name, 160, "El hito necesita un nombre."),
          notes: optionalText(input.notes, 2000),
        },
        clientTs: isoNow(),
        expectedVersion: null,
      };
      await queueMutation(context, mutation, "Hito GPS");
      return { mutationId, entityId };
    }

    async function summarize(contextKey) {
      const context = selectedContext(contextKey);
      const mutations = (await getAll(STORES.mutations)).filter((entry) => belongs(entry, context));
      const attachments = (await getAll(STORES.attachments)).filter((entry) => belongs(entry, context));
      return {
        pending: mutations.filter((entry) => entry.status === "pending" || entry.status === "syncing" || entry.status === "error").length,
        conflicts: mutations.filter((entry) => entry.status === "conflict").length,
        attachments: attachments.filter((entry) => entry.status !== "applied").length,
      };
    }

    async function flush(contextKey) {
      const context = selectedContext(contextKey);
      if (navigatorValue && navigatorValue.onLine === false) throw new Error("Todavía no hay conexión.");
      await refreshExactSession(context);
      let sent = 0;
      const mutations = (await getAll(STORES.mutations))
        .filter((entry) => belongs(entry, context) && (entry.status === "pending" || entry.status === "error"))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));
      for (const mutation of mutations) {
        const syncing = { ...mutation, status: "syncing", attempts: mutation.attempts + 1, updatedAt: isoNow() };
        await putValue(STORES.mutations, syncing);
        try {
          const response = await fetcher(syncing.url, {
            method: syncing.method,
            headers: { ...syncing.headers, "Idempotency-Key": syncing.mutationId },
            body: syncing.body,
            credentials: "same-origin",
          });
          const decision = await syncDecision(syncing, response);
          await putValue(STORES.mutations, {
            ...syncing,
            status: decision.status,
            statusReason: decision.reason,
            nextAttemptAt: decision.status === "error" ? new Date(now() + 2000).toISOString() : null,
            appliedAt: decision.status === "applied" ? isoNow() : null,
            updatedAt: isoNow(),
          });
          if (decision.status === "applied") sent += 1;
          if (response.status === 401 || response.status === 403 || response.status === 428) break;
        } catch {
          await putValue(STORES.mutations, {
            ...syncing,
            status: "error",
            statusReason: "La red se interrumpió; la captura sigue guardada.",
            nextAttemptAt: new Date(now() + 2000).toISOString(),
            updatedAt: isoNow(),
          });
          break;
        }
      }
      const uploaded = await flushAttachments(context);
      return { sent, uploaded, summary: await summarize(contextKey) };
    }

    async function refreshExactSession(context) {
      const response = await fetcher("/api/offline/session", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Vuelve a autenticarte antes de sincronizar; los datos siguen guardados.");
      const body = await response.json();
      const session = validateSession(body && body.session, context.scope);
      if (
        session.accountMode !== context.partition.accountMode
        || session.organizationId !== context.partition.organizationId
        || session.userSubject !== context.partition.userSubject
        || !session.fieldIds.includes(context.partition.fieldId)
      ) throw new Error("La cuenta autenticada no coincide con la partición local seleccionada.");
      context.session = session;
      await putValue(STORES.sessions, { id: sessionKey(context.scope), scope: context.scope, session });
    }

    async function flushAttachments(context) {
      let uploaded = 0;
      const currentMutations = (await getAll(STORES.mutations)).filter((entry) => belongs(entry, context));
      const attachments = (await getAll(STORES.attachments)).filter((entry) => belongs(entry, context) && (entry.status === "pending" || entry.status === "error"));
      for (const attachment of attachments) {
        const linked = currentMutations.find((entry) => {
          try {
            const body = JSON.parse(entry.body || "null");
            return body.mutations && body.mutations.some((mutation) => mutation.entityId === attachment.entityId && mutation.payload && mutation.payload.attachmentId === attachment.attachmentId);
          } catch { return false; }
        });
        if (!linked || linked.status !== "applied" || !attachment.blob) continue;
        const uploading = { ...attachment, status: "uploading", attempts: attachment.attempts + 1, updatedAt: isoNow() };
        await putValue(STORES.attachments, uploading);
        try {
          const form = new FormDataValue();
          form.set("fieldId", context.partition.fieldId);
          form.set("attachmentId", attachment.attachmentId);
          form.set("entityId", attachment.entityId);
          form.set("file", attachment.blob, attachment.filename);
          const response = await fetcher("/api/offline/attachments", {
            method: "POST",
            body: form,
            credentials: "same-origin",
            headers: { "Idempotency-Key": attachment.attachmentId },
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || !body || !body.attachment || !body.attachment.objectKey || !body.attachment.sha256) {
            await putValue(STORES.attachments, { ...uploading, status: "error", statusReason: body && body.error || "No fue posible subir la fotografía.", updatedAt: isoNow() });
            if (response.status === 401 || response.status === 403 || response.status === 428) break;
            continue;
          }
          uploaded += 1;
          await putValue(STORES.attachments, {
            ...uploading,
            blob: null,
            status: "applied",
            statusReason: null,
            objectKey: body.attachment.objectKey,
            sha256: body.attachment.sha256,
            updatedAt: isoNow(),
          });
        } catch {
          await putValue(STORES.attachments, { ...uploading, status: "error", statusReason: "La red se interrumpió durante la carga.", updatedAt: isoNow() });
          break;
        }
      }
      return uploaded;
    }

    async function queueMutation(context, mutation, label) {
      const queuedId = `sync:${mutation.id}:0`;
      const timestamp = isoNow();
      await putValue(STORES.mutations, {
        id: `mutation|${partitionKey(context.partition)}|${encodeURIComponent(queuedId)}`,
        mutationId: queuedId,
        transport: "sync-v1",
        scope: context.scope,
        partition: context.partition,
        url: "/api/sync",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mutations: [mutation] }),
        label,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        status: "pending",
        nextAttemptAt: null,
        statusReason: null,
        appliedAt: null,
      });
    }

    async function queueAttachment(context, attachmentId, entityId, file) {
      if (!ULID_PATTERN.test(attachmentId) || !IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > 1500000) {
        throw new Error("La fotografía debe ser JPEG, PNG, WebP o HEIC y no superar 1,5 MB.");
      }
      const timestamp = isoNow();
      await putValue(STORES.attachments, {
        id: `attachment|${partitionKey(context.partition)}|${attachmentId}`,
        attachmentId,
        scope: context.scope,
        partition: context.partition,
        entityId,
        filename: String(file.name || "captura").slice(0, 200),
        contentType: file.type,
        size: file.size,
        blob: file,
        status: "pending",
        attempts: 0,
        statusReason: null,
        objectKey: null,
        sha256: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }

    function livestockPayload(input, reference, animal, attachmentId) {
      const date = requiredDate(input.date);
      let payload;
      if (input.entity === "livestock_weighing") {
        const lot = reference.lots.find((entry) => entry.id === input.lotId && entry.fieldId === selectedField(input.contextKey));
        const weight = Number(input.weightKg);
        if (!lot || lot.trackingMode !== "individual" || animal.lotId !== lot.id) throw new Error("El animal y el lote individual no coinciden.");
        if (!Number.isFinite(weight) || weight <= 0 || weight > 2000) throw new Error("El peso debe estar entre 0 y 2.000 kg.");
        payload = { lotId: lot.id, recordedAt: date, notes: "Captura desde shell offline", entries: [{ animalId: animal.id, weightKg: weight }] };
      } else if (input.entity === "livestock_health") {
        payload = {
          animalId: animal.id, eventType: "treatment", occurredAt: date, status: "completed",
          condition: requiredText(input.detail, 2000, "Describe el evento sanitario."),
          productName: requiredText(input.product, 160, "Indica el producto."), activeIngredient: null,
          doseAmount: null, doseUnit: null, route: null, withdrawalMilkUntil: null, withdrawalMeatUntil: null,
          professional: null, notes: "Captura desde shell offline",
        };
      } else if (input.entity === "livestock_estrus") {
        payload = { animalId: animal.id, occurredAt: date, method: "observación visual", result: optionalText(input.detail, 2000) || null, sireIdentifier: null, notes: "Captura desde shell offline" };
      } else {
        payload = { animalIds: [animal.id], occurredAt: date, destinationRup: requiredText(input.destinationRup, 32, "Indica el RUP de destino.").toUpperCase(), notes: optionalText(input.detail, 2000), state: "pending_fma" };
      }
      return attachmentId ? { ...payload, attachmentId } : payload;
    }

    function selectedField(contextKey) { return selectedContext(contextKey).partition.fieldId; }
    function selectedContext(key) {
      const context = contexts.get(key);
      if (!context) throw new Error("Selecciona una cuenta local y un fundo.");
      return context;
    }
    function captureContext(key) {
      const context = selectedContext(key);
      if (Date.parse(context.session.expiresAt) <= now()) throw new Error("La sesión local expiró. Conéctate para renovarla antes de capturar.");
      return context;
    }
    function publicContext(context) {
      return { key: context.key, label: context.label, expiresAt: context.session.expiresAt, captureAllowed: Date.parse(context.session.expiresAt) > now() };
    }
    function isoNow() { return new Date(now()).toISOString(); }

    async function syncDecision(mutation, response) {
      if (!response.ok) {
        if (response.status === 409) return { status: "conflict", reason: "El servidor detectó un conflicto que requiere revisión." };
        if (response.status === 401 || response.status === 403) return { status: "error", reason: "La sesión debe revalidarse antes de sincronizar." };
        if (response.status === 428) return { status: "error", reason: "Debes revisar la versión legal vigente; la captura sigue guardada." };
        return { status: "error", reason: "El servidor no pudo aplicar la captura." };
      }
      try {
        const requestBody = JSON.parse(mutation.body || "null");
        const body = await response.clone().json();
        const ids = requestBody.mutations.map((entry) => entry.id);
        if (!Array.isArray(body.results) || body.results.length !== ids.length) throw new Error();
        const results = new Map(body.results.map((entry) => [entry.id, entry]));
        if (ids.some((id) => !results.has(id))) throw new Error();
        const unresolved = ids.map((id) => results.get(id)).find((entry) => entry.status !== "applied");
        return unresolved
          ? { status: "conflict", reason: unresolved.conflictReason || "La captura requiere revisión." }
          : { status: "applied", reason: null };
      } catch {
        return { status: "error", reason: "El servidor devolvió una respuesta incompleta." };
      }
    }

    function validateSession(value, scope) {
      const parts = typeof scope === "string" ? scope.split(".").map((entry) => entry.trim()).filter(Boolean) : [];
      if (!value || typeof value !== "object" || parts.length < 3) throw new TypeError("Sesión inválida.");
      const fields = Array.isArray(value.fieldIds) ? value.fieldIds.filter((entry) => typeof entry === "string" && entry.trim()).sort() : [];
      const scopedFields = parts.slice(2).sort();
      if (
        value.version !== 1 || value.audience !== "fundosmart-offline-v1" || typeof value.token !== "string"
        || value.token.split(".").length !== 2 || value.membershipId !== parts[0] || value.role !== parts[1]
        || !["personal", "demo"].includes(value.accountMode) || typeof value.organizationId !== "string"
        || !/^[a-f0-9]{64}$/u.test(String(value.userSubject)) || JSON.stringify(fields) !== JSON.stringify(scopedFields)
        || !Number.isFinite(Date.parse(value.issuedAt)) || !Number.isFinite(Date.parse(value.expiresAt))
      ) throw new TypeError("Sesión inválida.");
      return { ...value, fieldIds: fields };
    }

    function normalizePartition(value) {
      const partition = {
        accountMode: String(value.accountMode || "").trim(), organizationId: String(value.organizationId || "").trim(),
        userSubject: String(value.userSubject || "").trim(), fieldId: String(value.fieldId || "").trim(),
      };
      if (!partition.organizationId || !partition.userSubject || !partition.fieldId || !["personal", "demo"].includes(partition.accountMode)) throw new TypeError("Partición inválida.");
      return partition;
    }
    function partitionKey(partition) { return [partition.accountMode, partition.organizationId, partition.userSubject, partition.fieldId].map(encodeURIComponent).join("|"); }
    function readModelKey(partition, name) { return `read-model|${partitionKey(partition)}|${encodeURIComponent(name)}`; }
    function sessionKey(scope) { return `session|${encodeURIComponent(scope)}`; }
    function belongs(entry, context) { return entry && entry.scope === context.scope && entry.partition && partitionKey(entry.partition) === partitionKey(context.partition); }
    function validReference(record, partition) {
      return record && record.partition && partitionKey(record.partition) === partitionKey(partition) && record.name === "livestock-field-reference-v1"
        && record.value && record.value.version === 1 && Array.isArray(record.value.animals) && Array.isArray(record.value.lots);
    }
    function validGeographic(record, partition) {
      return record && record.partition && partitionKey(record.partition) === partitionKey(partition) && record.name === "paddock-geography-v1"
        && record.value && record.value.fieldId === partition.fieldId && Array.isArray(record.value.paddocks) && Array.isArray(record.value.landmarks);
    }
    function requiredDate(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value)) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) throw new Error("Indica una fecha válida.");
      return value;
    }
    function requiredText(value, maximum, message) { const text = String(value || "").trim(); if (!text || text.length > maximum) throw new Error(message); return text; }
    function optionalText(value, maximum) { return String(value || "").trim().slice(0, maximum); }

    async function openDatabase() {
      if (!idb) throw new Error("Este navegador no ofrece almacenamiento offline.");
      return new Promise((resolve, reject) => {
        const request = idb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          for (const store of Object.values(STORES)) if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "id" });
          for (const store of ["cursors"]) if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async function storeRequest(storeName, mode, operation) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(storeName, mode);
        const result = await requestPromise(operation(transaction.objectStore(storeName)));
        await transactionPromise(transaction);
        return result;
      } finally { database.close(); }
    }
    function getAll(store) { return storeRequest(store, "readonly", (value) => value.getAll()); }
    function getValue(store, key) { return storeRequest(store, "readonly", (value) => value.get(key)); }
    function putValue(store, value) { return storeRequest(store, "readwrite", (target) => target.put(value)); }
    function requestPromise(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    function transactionPromise(transaction) { return new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); transaction.onerror = () => reject(transaction.error); }); }

    return { createId, loadContexts, readContext, queueLivestockCapture, queueLandmark, summarize, flush };
  }

  function captureLabel(entity) {
    return ({ livestock_weighing: "Pesaje", livestock_health: "Evento sanitario", livestock_estrus: "Celo observado", livestock_movement: "Movimiento para FMA" })[entity] || "Captura de terreno";
  }

  global.FundoSmartOfflineCapture = { createRuntime };
  if (global.document) global.document.addEventListener("DOMContentLoaded", () => boot(createRuntime()));

  async function boot(runtime) {
    const byId = (id) => global.document.getElementById(id);
    const scope = byId("scope");
    const capture = byId("capture-form");
    const landmark = byId("landmark-form");
    const entity = byId("entity");
    const message = byId("message");
    const sync = byId("sync");
    let current = null;

    function report(text, error) { message.textContent = text; message.dataset.error = error ? "true" : "false"; }
    function today() { return new Date().toISOString().slice(0, 10); }
    byId("date").value = today();

    async function updateSummary() {
      if (!current) return;
      const summary = await runtime.summarize(current);
      byId("summary").textContent = `Pendientes ${summary.pending} · Conflictos ${summary.conflicts} · Fotos ${summary.attachments}`;
    }

    async function choose(value) {
      current = value || null;
      capture.hidden = true;
      landmark.hidden = true;
      if (!current) { report("Selecciona explícitamente una cuenta local y un fundo.", false); return; }
      const model = await runtime.readContext(current);
      const animals = model.reference ? model.reference.animals : [];
      const lots = model.reference ? model.reference.lots.filter((entry) => entry.trackingMode === "individual") : [];
      byId("animal").replaceChildren(option("", "Selecciona DIIO"), ...animals.filter((entry) => entry.status === "active").map((entry) => option(entry.id, entry.tag)));
      byId("lot").replaceChildren(option("", "Selecciona lote"), ...lots.map((entry) => option(entry.id, entry.name)));
      capture.hidden = !model.reference || !model.context.captureAllowed;
      landmark.hidden = !model.geographic || !model.context.captureAllowed;
      sync.disabled = false;
      if (!model.context.captureAllowed) report("La sesión local expiró. Puedes sincronizar al autenticarte, pero no crear capturas nuevas.", true);
      else if (!model.reference) report("No hay inventario local. Abre Terreno con señal para prepararlo.", true);
      else report("Partición local seleccionada. Las capturas quedan sólo en este dispositivo hasta sincronizar.", false);
      await updateSummary();
    }

    function option(value, label) { const element = global.document.createElement("option"); element.value = value; element.textContent = label; return element; }
    function refreshMode() {
      const mode = entity.value;
      byId("lot-row").hidden = mode !== "livestock_weighing";
      byId("weight-row").hidden = mode !== "livestock_weighing";
      byId("product-row").hidden = mode !== "livestock_health";
      byId("rup-row").hidden = mode !== "livestock_movement";
      byId("detail-row").hidden = mode === "livestock_weighing";
    }
    entity.addEventListener("change", refreshMode);
    refreshMode();
    scope.addEventListener("change", () => { void choose(scope.value).catch((cause) => report(cause.message, true)); });

    capture.addEventListener("submit", (event) => {
      event.preventDefault();
      const file = byId("photo").files[0] || null;
      void runtime.queueLivestockCapture({
        contextKey: current, entity: entity.value, animalId: byId("animal").value, lotId: byId("lot").value,
        weightKg: byId("weight").value, date: byId("date").value, product: byId("product").value,
        destinationRup: byId("rup").value, detail: byId("detail").value, file,
      }).then(async () => { capture.reset(); byId("date").value = today(); refreshMode(); report("Captura guardada de forma particionada en este dispositivo.", false); await updateSummary(); })
        .catch((cause) => report(cause.message, true));
    });

    byId("locate").addEventListener("click", () => {
      if (!global.navigator.geolocation) return report("Este dispositivo no ofrece ubicación.", true);
      global.navigator.geolocation.getCurrentPosition((position) => {
        byId("latitude").value = position.coords.latitude.toFixed(7);
        byId("longitude").value = position.coords.longitude.toFixed(7);
        report("Coordenada GPS lista para revisar y guardar.", false);
      }, () => report("No fue posible obtener la ubicación.", true), { enableHighAccuracy: true, timeout: 10000 });
    });
    landmark.addEventListener("submit", (event) => {
      event.preventDefault();
      void runtime.queueLandmark({ contextKey: current, kind: byId("kind").value, name: byId("landmark-name").value, notes: byId("landmark-notes").value, latitude: byId("latitude").value, longitude: byId("longitude").value })
        .then(async () => { landmark.reset(); report("Hito GPS guardado en la cola local.", false); await updateSummary(); })
        .catch((cause) => report(cause.message, true));
    });
    sync.addEventListener("click", () => {
      if (!current) return report("Selecciona una partición antes de sincronizar.", true);
      sync.disabled = true;
      void runtime.flush(current).then(async (result) => {
        await choose(current);
        report(`${result.sent} capturas y ${result.uploaded} fotos sincronizadas.`, false);
      })
        .catch((cause) => report(cause.message, true)).finally(async () => { sync.disabled = false; await updateSummary(); });
    });
    global.addEventListener("online", () => { if (current) void runtime.flush(current).then(updateSummary).catch(() => undefined); });
    if (global.navigator.serviceWorker) {
      global.navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "fundosmart:offline-sync-request" && current) void runtime.flush(current).then(updateSummary).catch(() => undefined);
      });
    }

    try {
      const available = await runtime.loadContexts();
      scope.replaceChildren(option("", available.length > 1 ? "Selecciona cuenta y fundo" : "Cuenta y fundo local"), ...available.map((entry) => option(entry.key, entry.label)));
      if (available.length === 1) { scope.value = available[0].key; await choose(available[0].key); }
      else if (available.length === 0) report("No existe una sesión local válida. Abre Terreno con señal antes de trabajar offline.", true);
      else report("Hay más de una partición local. Selecciona explícitamente dónde registrar.", false);
    } catch (cause) { report(cause.message || "No fue posible abrir el almacenamiento local.", true); }
  }
})(globalThis);
