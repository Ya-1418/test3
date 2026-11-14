/*
====================================================================
طابور البلاغات المحلي (client-side outbox)
====================================================
لماذا هذا الملف موجود:
    كانت الاستمارة تنتظر رد Google Apps Script (بطيء: ثوانٍ عديدة) قبل أن
    تُظهر «تم الإرسال»، فيقف المبلّغ أمام شاشة «جارٍ الإرسال...» بلا داعٍ.

الحل:
    • عند الضغط على «إرسال» يُحفظ البلاغ فوراً في مخزن محلي دائم
      (IndexedDB) داخل جهاز المبلّغ.
    • ننتقل فوراً إلى صفحة النجاح — بلا انتظار أي شبكة.
    * ثم يُرسَل البلاغ في الخلفية عبر هذا الملف (من index.html أو
      success.html)، مع إعادة محاولة تلقائية. وإن أُغلق المتصفح قبل
      الإرسال، يُرسَل عند أول زيارة قادمة للنموذج.
    * لا يضيع البلاغ أبداً: لا يُحذف من الحفظ المؤقت إلا بعد تأكيد
      التسليم الفعلي (إيصال من الخادم أو رد GAS مباشر)، ويُمنع التكرار
      عبر remoteId نفسه.

يعمل مع النسختين: المتصلة بخادمنا المحلي (المسار النسبي) والمنشورة على
استضافة خارجية (السقوط إلى Google Apps Script).
*/

(function () {
    'use strict';

    var DB_NAME = 'maintenance_reporter_outbox';
    var DB_VERSION = 1;
    var STORE = 'pending';
    var RECEIPT_DB_NAME = 'maintenance_reporter_receipts';
    var RECEIPT_DB_VERSION = 1;
    var RECEIPT_STORE = 'receipts';
    var PENDING_SUBMISSION_KEY = 'reporterPendingSubmission';
    var CURRENT_SUBMISSION_KEY = 'reporterCurrentSubmission';
    var LOCAL_RECEIPT_PREFIX = 'reporterDeliveryReceipt:';
    const GAS_FALLBACK_URL =
        'https://script.google.com/macros/s/AKfycbx5bXnsZ-XidPzrF2-k3tzGM3h3bT_EeapAj4AERiDuoNRXwqoeLk2KCK92gGZzPfvyfg/exec';
    const API_ENDPOINTS = ['/api/reporter/submit', GAS_FALLBACK_URL];
    const TIMEOUT_MS = 12000;
    const MAX_ATTEMPTS_PER_ENDPOINT = 2;
    const STATUS_CHECK_INTERVAL_MS = 5000;
    const STATUS_TIMEOUT_MS = 8000;
    const RETRY_BASE_MS = 1000;
    const RETRY_MAX_MS = 30000;

    function available() {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    }

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!available()) { reject(new Error('IndexedDB غير متاح')); return; }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    // IndexedDB requests carry their value in `.result`. A miss (get of an
    // absent key) has `result === undefined`, so the old truthiness check
    // resolved the request object itself and enqueue treated every new report
    // as an existing record with a different payload. Detect the request
    // itself instead of guessing from `.result`.
    function requestValue(value) {
        if (!value || typeof value !== 'object') return value;
        try {
            if (typeof IDBRequest !== 'undefined' && value instanceof IDBRequest) {
                return value.result;
            }
        } catch (error) { /* بيئات لا تُعرّف IDBRequest */ }
        if ('readyState' in value && 'onsuccess' in value && 'result' in value) {
            return value.result;
        }
        return value;
    }

    function withStore(mode, fn) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(STORE, mode);
                var store = tx.objectStore(STORE);
                var req = fn(store);
                tx.oncomplete = function () {
                    resolve(requestValue(req));
                };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error); };
            });
        });
    }

    function openReceiptDb() {
        return new Promise(function (resolve, reject) {
            if (!available()) { reject(new Error('IndexedDB غير متاح')); return; }
            var req = indexedDB.open(RECEIPT_DB_NAME, RECEIPT_DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(RECEIPT_STORE)) {
                    db.createObjectStore(RECEIPT_STORE, { keyPath: 'remoteId' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
            req.onblocked = function () { reject(new Error('تعذّر فتح مخزن إيصالات التسليم')); };
        });
    }

    function withReceiptStore(mode, fn) {
        return openReceiptDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(RECEIPT_STORE, mode);
                var store = tx.objectStore(RECEIPT_STORE);
                var req = fn(store);
                tx.oncomplete = function () {
                    resolve(requestValue(req));
                };
                tx.onerror = function () { reject(tx.error); };
                tx.onabort = function () { reject(tx.error); };
            });
        });
    }

    // إيصال تسليم محلي دائم: لا يُكتب إلا بعد رد يطابق remoteId حرفياً.
    // الغرض منه أن تعرف success.html أن GAS استلم البلاغ حتى لو حُذف سجل
    // الطابور، وبعد إعادة فتح الصفحة. هو ليس توقيعاً خادمياً ولا يُغني عن
    // التحقق من الخادم المحلي عند توفره. عند تعذّر IndexedDB نستخدم
    // localStorage كتأكيد محلي صريح، مع وسم storage:'local-cache'.
    function saveDeliveryReceipt(remoteId, source, fingerprint) {
        var key = String(remoteId || '').trim();
        if (!key) return Promise.resolve(false);
        var receipt = {
            remoteId: key,
            ok: true,
            delivered: true,
            source: source === 'local' ? 'local' : 'gas',
            storage: 'indexeddb',
            fingerprint: String(fingerprint || '').slice(0, 4000),
            recordedAt: new Date().toISOString()
        };
        return withReceiptStore('readwrite', function (store) {
            return store.put(receipt);
        }).then(function () {
            return true;
        }).catch(function () {
            receipt.storage = 'local-cache';
            try {
                localStorage.setItem(LOCAL_RECEIPT_PREFIX + key, JSON.stringify(receipt));
                return true;
            } catch (error) {
                return false;
            }
        });
    }

    function receiptMatches(receipt, key, expectedFingerprint) {
        if (!receipt || typeof receipt !== 'object') return false;
        if (String(receipt.remoteId || '').trim() !== key) return false;
        if (receipt.ok !== true || receipt.delivered !== true) return false;
        if (receipt.source !== 'local' && receipt.source !== 'gas') return false;
        if (receipt.storage !== 'indexeddb' && receipt.storage !== 'local-cache') return false;
        var expected = String(expectedFingerprint || '').trim();
        if (expected) {
            if (!receipt.fingerprint || String(receipt.fingerprint) !== expected) return false;
        }
        return true;
    }

    function readLocalReceipt(key, expectedFingerprint) {
        try {
            var raw = localStorage.getItem(LOCAL_RECEIPT_PREFIX + key);
            if (!raw) return null;
            var receipt = JSON.parse(raw);
            return receiptMatches(receipt, key, expectedFingerprint) ? receipt : null;
        } catch (error) {
            return null;
        }
    }

    function getDeliveryReceipt(remoteId, expectedFingerprint) {
        var key = String(remoteId || '').trim();
        if (!key) return Promise.resolve(null);
        return withReceiptStore('readonly', function (store) {
            return store.get(key);
        }).then(function (receipt) {
            if (receiptMatches(receipt, key, expectedFingerprint)) return receipt;
            return readLocalReceipt(key, expectedFingerprint);
        }).catch(function () {
            return readLocalReceipt(key, expectedFingerprint);
        });
    }

    function isUnconfirmedStatus(value) {
        var status = String(value || '').trim().toLowerCase();
        return status === 'queued' || status === 'pending' || status === 'unknown';
    }

    function responseConfirmsDelivery(remoteId, result, transport) {
        var key = String(remoteId || '').trim();
        if (!key || !result || typeof result !== 'object' || result.ok !== true) return false;
        if (String(result.remoteId == null ? '' : result.remoteId).trim() !== key) return false;
        // queued means "saved for later", never final delivery.
        if (result.queued === true) return false;
        if (result.delivered === false) return false;
        var status = String(result.status == null ? '' : result.status).trim().toLowerCase();
        // Any present status other than delivered is a rejection, including
        // contradictory {delivered:true,status:"pending"} responses.
        if (status && status !== 'delivered') return false;
        if (!status && result.delivered !== true) {
            // Current GAS contract: {ok:true, remoteId:"same"} is the explicit
            // compatible success marker. No negative marker is present.
            return transport !== 'local';
        }
        return true;
    }

    function recordVerifiedDelivery(remoteId, result, transport, fingerprint) {
        var key = String(remoteId || '').trim();
        if (!responseConfirmsDelivery(key, result, transport)) {
            return Promise.resolve(false);
        }
        return saveDeliveryReceipt(
            key,
            transport === 'local' ? 'local' : 'gas',
            fingerprint
        );
    }

    function putRecord(record) {
        return withStore('readwrite', function (store) { return store.put(record); });
    }

    function deleteRecord(id) {
        return withStore('readwrite', function (store) { return store.delete(id); });
    }

    function allRecords() {
        return withStore('readonly', function (store) { return store.getAll(); });
    }

    function getRecord(id) {
        return withStore('readonly', function (store) { return store.get(String(id)); });
    }

    function confirmDelivered(remoteId, fingerprint) {
        var key = String(remoteId || '');
        if (!key) return Promise.resolve(false);
        // لا نحذف من IndexedDB اعتماداً على sessionStorage أو على نداء سابق.
        // نطلب من الخادم تأكيد الإيصال بنفس الرقم قبل الحذف.
        return fetchStatus(key).then(function (data) {
            if (!data || data.status !== 'delivered') return false;
            if (!responseConfirmsDelivery(key, data, 'local')) return false;
            return recordVerifiedDelivery(key, {
                ok: true,
                remoteId: key,
                delivered: true,
                status: 'delivered'
            }, 'local', fingerprint).then(function (receiptSaved) {
                if (!receiptSaved) return false;
                return allRecords().then(function (records) {
                    return Promise.all((records || []).filter(function (record) {
                        return recordRemoteId(record) === key;
                    }).map(function (record) {
                        return deleteRecord(record.id);
                    })).then(function () { return true; });
                });
            });
        }).catch(function () { return false; });
    }

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function postOnce(endpoint, payload, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify(payload),
                signal: controller ? controller.signal : undefined
            }).then(function (resp) {
                if (timer) clearTimeout(timer);
                return resp.text().then(function (text) {
                    var parsed = null;
                    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
                    if (!parsed) {
                        var bad = new Error('استجابة غير صالحة من الخادم.');
                        bad.transient = true;
                        bad.endpointMissing = (resp.status === 404 || resp.status === 405 || resp.status === 0);
                        reject(bad);
                        return;
                    }
                    if (resp.ok && parsed.ok === true) { resolve(parsed); return; }
                    var err = new Error(parsed.error || 'تعذّر إرسال البلاغ.');
                    err.transient = resp.status >= 500 || resp.status === 0;
                    if (resp.status === 404 || resp.status === 405) err.endpointMissing = true;
                    reject(err);
                });
            }).catch(function (err) {
                if (timer) clearTimeout(timer);
                if (err && (err.transient || err.endpointMissing)) { reject(err); return; }
                var e = new Error(err && err.name === 'AbortError'
                    ? 'انتهت مهلة الاتصال بالخادم.'
                    : 'تعذّر الوصول إلى الخادم.');
                e.transient = true;
                reject(e);
            });
        });
    }

    function isLocalEndpoint(endpoint) {
        return endpoint === API_ENDPOINTS[0] || String(endpoint || '').indexOf('/api/') === 0;
    }

    function uncertainDelivery(message) {
        // خطأ بروتوكول وليس شبكة: لا نعيد نفس الطلب بلا داع، بل نجرّب
        // المسار البديل بنفس remoteId ثم نُبقي السجل لإعادة المحاولة.
        var error = new Error(message);
        error.transient = false;
        return error;
    }

    function sendRecord(record) {
        var endpoints = (record && Array.isArray(record.endpoints) && record.endpoints.length)
            ? record.endpoints
            : API_ENDPOINTS;
        var lastErr = null;

        function tryEndpoint(index) {
            if (index >= endpoints.length) {
                return Promise.reject(lastErr || new Error('تعذّر إرسال البلاغ.'));
            }
            var endpoint = endpoints[index];

            function attempt(n) {
                return postOnce(endpoint, record.payload, TIMEOUT_MS).then(function (res) {
                    var expectedRemoteId = recordRemoteId(record);
                    var transport = isLocalEndpoint(endpoint) ? 'local' : 'gas';
                    // queued is a local durable acknowledgement only. GAS must
                    // never be allowed to turn queued:true into a final result.
                    if (res && res.queued === true) {
                        if (transport === 'local') {
                            return {
                                state: 'queued',
                                response: res,
                                endpoint: endpoint,
                                transport: transport
                            };
                        }
                        throw uncertainDelivery('Google Apps Script أعاد queued:true بدلاً من تأكيد التسليم.');
                    }
                    if (!responseConfirmsDelivery(expectedRemoteId, res, transport)) {
                        throw uncertainDelivery('رد الخادم لم يؤكد التسليم أو كان متناقضاً.');
                    }
                    return {
                        state: 'delivered',
                        response: res,
                        endpoint: endpoint,
                        transport: transport
                    };
                }).catch(function (err) {
                    lastErr = err;
                    if (!err.transient || err.endpointMissing || n >= MAX_ATTEMPTS_PER_ENDPOINT) {
                        return tryEndpoint(index + 1);
                    }
                    return sleep(1200 * n).then(function () { return attempt(n + 1); });
                });
            }
            return attempt(1);
        }
        return tryEndpoint(0);
    }

    function recordRemoteId(record) {
        return String(
            (record && record.remoteId) ||
            (record && record.payload && record.payload.remoteId) ||
            (record && record.id) ||
            ''
        );
    }

    function rememberRemoteId(remoteId) {
        var key = String(remoteId || '');
        if (!key) return;
        var at = String(Date.now());
        try {
            sessionStorage.setItem('lastReportRemoteId', key);
            sessionStorage.setItem('lastReportRemoteIdAt', at);
        } catch (e) { /* التخزين المؤقت غير متاح */ }
        // يبقى الرقم متاحاً لصفحة النجاح حتى بعد إغلاق التبويب/المتصفح.
        try {
            localStorage.setItem('lastReportRemoteId', key);
            localStorage.setItem('lastReportRemoteIdAt', at);
        } catch (e) { /* التخزين المحلي غير متاح */ }
    }

    function normalizedField(value) {
        return String(value === undefined || value === null ? '' : value).trim();
    }

    // بصمة مستقرة لبيانات البلاغ تسمح باستعادة remoteId نفسه بعد إعادة
    // التحميل، وتمنع إعادة استخدامه لبلاغ مختلف. لا تتضمن remoteId ولا
    // التاريخ/الوقت المتغيّرين، وتشمل SHA-256 لمحتوى المرفق (وليس الاسم
    // أو الحجم فقط). إذا غاب الهاش فلا نستبدله ببيانات وصفية مضللة.
    function fingerprintPayload(payload) {
        var p = payload || {};
        var file = p.attachment || null;
        var attachment = file
            ? [
                normalizedField(file.name),
                normalizedField(file.type),
                Number(file.size) || 0,
                normalizedField(file.sha256 || file.contentHash || 'missing')
            ].join('|')
            : '';
        return [
            normalizedField(p.reporter),
            normalizedField(p.reporterPhone),
            normalizedField(p.extNo),
            normalizedField(p.dept),
            normalizedField(p.location),
            normalizedField(p.spec),
            normalizedField(p.priority),
            normalizedField(p.desc),
            attachment
        ].join('\u001f');
    }

    function generateRemoteId() {
        return 'PUB-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    }

    function readPendingSubmission() {
        try {
            var raw = localStorage.getItem(PENDING_SUBMISSION_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') throw new Error('invalid pending submission');
            var remoteId = String(parsed.remoteId || '').trim();
            var fingerprint = String(parsed.fingerprint || '');
            if (!/^PUB-[A-Za-z0-9_-]{4,160}$/.test(remoteId) || !fingerprint) {
                throw new Error('invalid pending submission');
            }
            return {
                remoteId: remoteId,
                fingerprint: fingerprint,
                createdAt: Number(parsed.createdAt) || 0
            };
        } catch (e) {
            try { localStorage.removeItem(PENDING_SUBMISSION_KEY); } catch (ignored) { /* التخزين غير متاح */ }
            return null;
        }
    }

    function writePendingSubmission(remoteId, fingerprint, createdAt) {
        var record = {
            remoteId: String(remoteId || '').trim(),
            fingerprint: String(fingerprint || ''),
            createdAt: Number(createdAt) || Date.now()
        };
        var persisted = false;
        try {
            localStorage.setItem(PENDING_SUBMISSION_KEY, JSON.stringify(record));
            persisted = true;
        } catch (e) { /* التخزين المحلي غير متاح */ }
        rememberRemoteId(record.remoteId);
        try { sessionStorage.setItem('lastReportState', 'pending'); } catch (e) { /* التخزين المؤقت غير متاح */ }
        record.persisted = persisted;
        return record;
    }

    function readCurrentSubmission() {
        // sessionStorage first: each tab keeps its own operation. A stale
        // outbox delivery in another tab must not replace this tab's result.
        var stores = [];
        try { stores.push(sessionStorage); } catch (e) { /* ignore */ }
        try { stores.push(localStorage); } catch (e) { /* ignore */ }
        for (var i = 0; i < stores.length; i++) {
            try {
                var raw = stores[i].getItem(CURRENT_SUBMISSION_KEY);
                if (!raw) continue;
                var parsed = JSON.parse(raw);
                var remoteId = String(parsed && parsed.remoteId || '').trim();
                var fingerprint = String(parsed && parsed.fingerprint || '');
                if (!/^PUB-[A-Za-z0-9_-]{4,160}$/.test(remoteId) || !fingerprint) continue;
                return {
                    remoteId: remoteId,
                    fingerprint: fingerprint,
                    createdAt: Number(parsed.createdAt) || 0
                };
            } catch (e) { /* try next store */ }
        }
        return null;
    }

    function writeCurrentSubmission(remoteId, fingerprint, createdAt) {
        var context = {
            remoteId: String(remoteId || '').trim(),
            fingerprint: String(fingerprint || ''),
            createdAt: Number(createdAt) || Date.now()
        };
        var persisted = false;
        try {
            sessionStorage.setItem(CURRENT_SUBMISSION_KEY, JSON.stringify(context));
            persisted = true;
        } catch (e) { /* ignore */ }
        try {
            localStorage.setItem(CURRENT_SUBMISSION_KEY, JSON.stringify(context));
            persisted = true;
        } catch (e) { /* ignore */ }
        context.persisted = persisted;
        return context;
    }

    function clearPendingSubmission(remoteId) {
        try {
            var current = readPendingSubmission();
            if (!current) return false;
            if (remoteId && current.remoteId !== String(remoteId).trim()) return false;
            localStorage.removeItem(PENDING_SUBMISSION_KEY);
            return true;
        } catch (e) {
            return false;
        }
    }

    function findByFingerprint(fingerprint) {
        if (!available()) return Promise.resolve(null);
        return allRecords().then(function (records) {
            var matches = (records || []).filter(function (record) {
                var stored = String(record && record.payloadFingerprint || '') ||
                    fingerprintPayload(record && record.payload);
                return stored === fingerprint;
            }).sort(function (a, b) {
                return (Number(a && a.createdAt) || 0) - (Number(b && b.createdAt) || 0);
            });
            return matches.length ? matches[0] : null;
        }).catch(function () {
            return null;
        });
    }

    // يعيد استخدام remoteId السابق فقط إذا كانت بصمة البلاغ مطابقة. البحث
    // يشمل pending والطابور الدائم، حتى لو أُغلقت الصفحة أو مُسح pending.
    // أي بيانات مختلفة تعني بلاغاً جديداً مستقلاً.
    function resolveSubmissionUnlocked(payload, candidateRemoteId) {
        var fingerprint = fingerprintPayload(payload);
        var existing = readPendingSubmission();
        var matchedRecord = null;
        var prelude = Promise.resolve(null);
        if (!(existing && existing.fingerprint === fingerprint)) {
            prelude = findByFingerprint(fingerprint);
        }
        return prelude.then(function (record) {
            matchedRecord = record;
            var remoteId = '';
            var createdAt = Date.now();
            if (existing && existing.fingerprint === fingerprint) {
                remoteId = existing.remoteId;
                createdAt = existing.createdAt || createdAt;
            } else if (matchedRecord) {
                remoteId = recordRemoteId(matchedRecord);
                createdAt = Number(matchedRecord.createdAt) || createdAt;
            } else if (!existing) {
                remoteId = String(candidateRemoteId || '').trim();
            }
            if (!remoteId) remoteId = generateRemoteId();
            if (!/^PUB-[A-Za-z0-9_-]{4,160}$/.test(remoteId)) {
                remoteId = generateRemoteId();
            }
            var pending = writePendingSubmission(remoteId, fingerprint, createdAt);
            var current = writeCurrentSubmission(remoteId, fingerprint, createdAt);
            return {
                remoteId: remoteId,
                fingerprint: fingerprint,
                createdAt: createdAt,
                reused: !!((existing && existing.remoteId === remoteId) || matchedRecord),
                persisted: !!(pending.persisted || current.persisted)
            };
        });
    }

    function resolveSubmission(payload, candidateRemoteId) {
        // Web Locks serializes two tabs racing to create the same report. When
        // unavailable, exact-duplicate matching still prevents a second
        // record, but truly simultaneous submission remains best-effort.
        try {
            if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
                return navigator.locks.request('reporter-submission', { mode: 'exclusive' }, function () {
                    return resolveSubmissionUnlocked(payload, candidateRemoteId);
                });
            }
        } catch (e) { /* fall through */ }
        return resolveSubmissionUnlocked(payload, candidateRemoteId);
    }

    function rememberDelivered(record) {
        var key = recordRemoteId(record);
        var current = readCurrentSubmission();
        // A delivery for an older report must never become the current result.
        if (!current || current.remoteId === key) {
            rememberRemoteId(key);
            try { sessionStorage.setItem('lastReportState', 'delivered'); } catch (e) { /* ignore */ }
        }
    }

    function markQueued(record) {
        record.status = 'queued';
        record.remoteId = recordRemoteId(record);
        record.queuedAt = record.queuedAt || Date.now();
        record.attempts = 0;
        record.lastError = '';
        record.nextAttemptAt = Date.now() + STATUS_CHECK_INTERVAL_MS;
        return putRecord(record);
    }

    function markRetry(record, error) {
        record.attempts = Number(record.attempts || 0) + 1;
        record.lastError = String((error && error.message) || error || 'تعذّر الإرسال');
        var delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(record.attempts, 7)));
        record.nextAttemptAt = Date.now() + delay;
        return putRecord(record);
    }

    function sendAndPersist(record) {
        return sendRecord(record).then(function (result) {
            if (result.state === 'delivered') {
                // الإيصال يُكتب قبل حذف سجل الطابور. إذا تعذّر حفظه لا نحذف
                // السجل مطلقاً؛ نعيد المحاولة بالرقم نفسه حتى يصبح الدليل
                // المحلي متاحاً.
                return recordVerifiedDelivery(
                    recordRemoteId(record),
                    result.response,
                    result.transport,
                    record.payloadFingerprint || fingerprintPayload(record.payload)
                ).then(function (receiptSaved) {
                    if (!receiptSaved) {
                        return markRetry(record, new Error('تعذّر حفظ إيصال التسليم؛ أُبقي البلاغ في الطابور.'));
                    }
                    rememberDelivered(record);
                    return deleteRecord(record.id).catch(function () {
                        // الإيصال موجود؛ ترك السجل ليس فقداناً، لكن نمنع
                        // اعتباره pending في تقرير النجاح إن أمكن.
                        return markRetry(record, new Error('تعذّر حذف سجل الطابور بعد حفظ الإيصال.'));
                    });
                });
            }
            if (result.state === 'queued') return markQueued(record);
            return markRetry(record, new Error('لم يتأكد تسليم البلاغ.'));
        }).catch(function (error) {
            return markRetry(record, error);
        });
    }

    function fetchStatus(remoteId) {
        return new Promise(function (resolve, reject) {
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timer = controller ? setTimeout(function () { controller.abort(); }, STATUS_TIMEOUT_MS) : null;
            fetch('/api/report-outbox/status?remoteId=' + encodeURIComponent(remoteId), {
                cache: 'no-store',
                signal: controller ? controller.signal : undefined
            }).then(function (response) {
                if (timer) clearTimeout(timer);
                if (!response.ok) throw new Error('تعذّر التحقق من حالة البلاغ.');
                return response.json();
            }).then(function (data) {
                if (!data || data.ok !== true) throw new Error('استجابة حالة البلاغ غير صالحة.');
                resolve(data);
            }).catch(function (error) {
                if (timer) clearTimeout(timer);
                reject(error);
            });
        });
    }

    function checkQueued(record) {
        var remoteId = recordRemoteId(record);
        if (!remoteId) return Promise.resolve();
        return fetchStatus(remoteId).then(function (data) {
            // لا نحذف إلا إذا أكد الخادم الحالة لنفس رقم البلاغ.
            if (data && data.status === 'delivered') {
                if (!responseConfirmsDelivery(remoteId, data, 'local')) {
                    record.lastError = 'رد حالة متناقض؛ أُبقي البلاغ في الطابور.';
                    record.nextAttemptAt = Date.now() + STATUS_CHECK_INTERVAL_MS;
                    return putRecord(record);
                }
                return recordVerifiedDelivery(remoteId, {
                    ok: true,
                    remoteId: remoteId,
                    delivered: true,
                    status: 'delivered'
                }, 'local', record.payloadFingerprint || fingerprintPayload(record.payload)).then(function (receiptSaved) {
                    if (!receiptSaved) {
                        record.lastError = 'تعذّر حفظ إيصال التسليم؛ أُبقي البلاغ في الطابور.';
                        record.nextAttemptAt = Date.now() + STATUS_CHECK_INTERVAL_MS;
                        return putRecord(record);
                    }
                    rememberDelivered(record);
                    return deleteRecord(record.id);
                });
            }
            if (data && data.status === 'pending') {
                record.nextAttemptAt = Date.now() + STATUS_CHECK_INTERVAL_MS;
                return putRecord(record);
            }
            // الحالة غير معروفة أو لا تطابق رقم البلاغ: نعيد المحاولة بنفس
            // remoteId. الخادم وGAS يمنعان التكرار.
            record.status = 'pending';
            record.nextAttemptAt = 0;
            return putRecord(record).then(function () { return sendAndPersist(record); });
        }).catch(function (error) {
            record.lastError = String((error && error.message) || error || 'تعذّر التحقق من الحالة');
            record.nextAttemptAt = Date.now() + STATUS_CHECK_INTERVAL_MS;
            return putRecord(record);
        });
    }

    var flushing = false;

    function flush() {
        if (flushing || !available()) return Promise.resolve();
        flushing = true;
        return allRecords().then(function (records) {
            records = (records || []).filter(function (record) {
                return !record.nextAttemptAt || Number(record.nextAttemptAt) <= Date.now();
            });
            records.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
            return records.reduce(function (chain, record) {
                return chain.then(function () {
                    if (record.status === 'queued') return checkQueued(record);
                    return sendAndPersist(record);
                });
            }, Promise.resolve());
        }).catch(function () {
            // لا شيء.
        }).then(function () {
            flushing = false;
        });
    }

    function enqueue(payload) {
        var id = (payload && payload.remoteId)
            ? String(payload.remoteId)
            : ('anon-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        var fingerprint = fingerprintPayload(payload);
        return getRecord(id).then(function (existing) {
            if (existing) {
                var existingFingerprint = String(existing.payloadFingerprint || '') ||
                    fingerprintPayload(existing.payload);
                if (existingFingerprint && existingFingerprint !== fingerprint) {
                    var conflict = new Error('رقم البلاغ مستخدم لبلاغ مختلف.');
                    conflict.code = 'REMOTE_ID_PAYLOAD_MISMATCH';
                    throw conflict;
                }
                // Keep the original queue position/attempts; only refresh the
                // volatile payload fields (date/time/submittedAt).
                existing.payload = payload;
                existing.remoteId = id;
                existing.payloadFingerprint = fingerprint;
                return putRecord(existing).then(function () { return existing; });
            }
            // No duplicate record when an unresolved report with the same
            // fingerprint is already queued under another id.
            return findByFingerprint(fingerprint).then(function (match) {
                if (match && recordRemoteId(match) !== id) return match;
                var record = {
                    id: id,
                    remoteId: id,
                    payload: payload,
                    payloadFingerprint: fingerprint,
                    endpoints: API_ENDPOINTS,
                    createdAt: Date.now(),
                    status: 'pending',
                    attempts: 0,
                    nextAttemptAt: 0,
                    lastError: ''
                };
                rememberRemoteId(id);
                return putRecord(record).then(function () { return record; });
            });
        });
    }

    function startFlush() {
        flush();
    }

    window.ReporterOutbox = {
        available: available,
        enqueue: enqueue,
        flush: flush,
        getRecord: getRecord,
        confirmDelivered: confirmDelivered,
        getPendingSubmission: readPendingSubmission,
        getCurrentSubmission: readCurrentSubmission,
        prepareSubmission: resolveSubmission,
        clearPendingSubmission: clearPendingSubmission,
        recordVerifiedDelivery: recordVerifiedDelivery,
        getDeliveryReceipt: getDeliveryReceipt,
        responseConfirmsDelivery: responseConfirmsDelivery,
        isUnconfirmedStatus: isUnconfirmedStatus,
        fingerprintPayload: fingerprintPayload
    };

    // محاولة إرسال أي بلاغات متأخرة عند فتح الصفحة، وعند عودة الاتصال.
    if (available()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startFlush);
        } else {
            startFlush();
        }
        window.addEventListener('online', startFlush);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') startFlush();
        });
        setInterval(startFlush, STATUS_CHECK_INTERVAL_MS);
    }
})();
