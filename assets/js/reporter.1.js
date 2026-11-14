


/*
====================================================
رابط Google Apps Script
====================================================
*/

const API_URL =
'/api/reporter/submit';

/*
عند نشر نموذج البلاغ على استضافة خارجية (بلا خادمنا المحلي) يفشل الاتصال
بالمسار النسبي أعلاه. في هذه الحالة نسقط تلقائياً إلى خدمة Google Apps Script
نفسها، فتُستقبل البلاغات حتى لو كان البرنامج مغلقاً — بنفس الملف، محلياً
وعبر الإنترنت. (نفس وجهة الملف المنشور في dist/reporter-site.)
*/
const GAS_FALLBACK_URL =
'https://script.google.com/macros/s/AKfycbx5bXnsZ-XidPzrF2-k3tzGM3h3bT_EeapAj4AERiDuoNRXwqoeLk2KCK92gGZzPfvyfg/exec';

const API_ENDPOINTS = [API_URL, GAS_FALLBACK_URL];



/*
====================================================
اختصار العناصر
====================================================
*/

const $ = id =>
document.getElementById(id);

const deptSelect = $('dept');
const deptCustom = $('dept-custom');
if (deptSelect && deptCustom) {
    deptSelect.addEventListener('change', () => {
        const custom = deptSelect.value === '__custom__';
        deptCustom.classList.toggle('hidden', !custom);
        deptCustom.required = custom;
        if (custom) deptCustom.focus(); else deptCustom.value = '';
    });
}



/*
====================================================
رسالة الحالة
====================================================
*/

function setStatus(message, type = 'success') {

    const el = $('status');

    el.textContent = message;

    el.className =
        'rounded-xl p-4 font-bold ' +
        (
            type === 'success'
            ?
            'bg-green-50 text-green-700 border border-green-200'
            :
            'bg-red-50 text-red-700 border border-red-200'
        );

}

function resetReportFormAfterSubmit() {
    const form = $('report-form');
    if (form) form.reset();
    if (deptCustom) {
        deptCustom.value = '';
        deptCustom.classList.add('hidden');
        deptCustom.required = false;
    }
    const preview = $('preview');
    if (preview) preview.textContent = '';
}

function rememberLastReport(remoteId, state) {
    var key = String(remoteId || '');
    var at = String(Date.now());
    try {
        sessionStorage.setItem('lastReportRemoteId', key);
        sessionStorage.setItem('lastReportRemoteIdAt', at);
        sessionStorage.setItem('lastReportState', String(state || ''));
    } catch (e) { /* التخزين المؤقت غير متاح */ }
    // نُبقي رقم البلاغ بعد إغلاق التبويب/المتصفح، لكن الحالة وحدها
    // لا تُستخدم أبداً كدليل تسليم في success.html.
    try {
        localStorage.setItem('lastReportRemoteId', key);
        localStorage.setItem('lastReportRemoteIdAt', at);
    } catch (e) { /* التخزين المحلي غير متاح */ }
}

function getRiyadhDateParts(date) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Riyadh',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(date);
        const get = type => (parts.find(part => part.type === type) || {}).value || '';
        return {
            date: `${get('year')}-${get('month')}-${get('day')}`,
            time: `${get('hour')}:${get('minute')}`
        };
    } catch (e) {
        // السعودية UTC+3 بلا توقيت صيفي؛ هذا احتياطي إن غاب Intl.
        const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
        return {
            date: shifted.toISOString().slice(0, 10),
            time: shifted.toISOString().slice(11, 16)
        };
    }
}



/*
====================================================
تحويل الملف إلى Base64
====================================================
*/

function sha256Hex(buffer) {

    if (!globalThis.crypto || !globalThis.crypto.subtle || typeof globalThis.crypto.subtle.digest !== 'function') {
        return Promise.reject(new Error('تعذّر حساب بصمة محتوى المرفق: Web Crypto غير متاح.'));
    }

    return globalThis.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
        return Array.from(new Uint8Array(digest)).map(function (byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    });

}

async function optimizeImageFile(file) {
    if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type) || file.size < 700 * 1024) return file;
    if (typeof createImageBitmap !== 'function') return file;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

async function fileToDataUrl(file) {

    if (!file) return null;

    if (file.size > 5 * 1024 * 1024) {
        throw new Error('حجم المرفق أكبر من 5 ميجابايت');
    }

    try { file = await optimizeImageFile(file); } catch { /* نستخدم الملف الأصلي إذا تعذر الضغط */ }

    let attachmentHash = '';
    try {
        if (!file.arrayBuffer) throw new Error('File.arrayBuffer غير متاح');
        const buffer = await file.arrayBuffer();
        attachmentHash = await sha256Hex(buffer);
    } catch (error) {
        throw new Error('تعذّر التحقق من محتوى المرفق. أعد اختيار الملف أو احذف المرفق قبل الإرسال.');
    }

    return new Promise((resolve, reject) => {

        const reader = new FileReader();

        reader.onload = () => {

            resolve({

                name: file.name,

                type: file.type,

                size: file.size,

                sha256: attachmentHash,

                dataUrl: reader.result

            });

        };


        reader.onerror = () => {

            reject(
                new Error(
                    'تعذر قراءة المرفق'
                )
            );

        };


        reader.readAsDataURL(file);

    });

}



/*
====================================================
عرض اسم الملف
====================================================
*/

$('attachment')
.addEventListener(
    'change',
    () => {

        const file =
            $('attachment').files[0];


        if (!file) {

            $('preview').textContent = '';

            return;
        }


        if (file.size > 5 * 1024 * 1024) {

            $('preview').textContent =
                'حجم الملف أكبر من 5 ميجابايت';

            $('preview').className =
                'mt-3 text-red-600 font-bold';

            return;
        }


        $('preview').textContent =
            'المرفق: ' + file.name;


        $('preview').className =
            'mt-3 text-green-700 font-bold';

    }
);



/*
====================================================
كشف قدرة رفع الملفات (5.4)
====================================================
عند فتح الصفحة نسأل الخادم في الخلفية أي نسخة من
Google Apps Script منشورة. النسخة الجديدة (v2) تدعم
رفع المرفق كرابط Drive؛ النسخة القديمة ترد «Invalid
action». بهذه المعلومة نتجنّب إهدار ~6 ثوانٍ في محاولة
رفع مضمونة الفشل عند كل إرسال بصورة — ويُرسل المرفق
مضمّناً كما كان، بلا تغيير في السلوك ولا ضياع لأي بلاغ.
*/

const uploadSupportState = {
    known: false,
    supported: false
};

if (typeof fetch !== 'undefined') {
    fetch(
        '/api/attachment/upload',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body:
                JSON.stringify({
                    action: 'version'
                })
        }
    )
        .then(r => r.json())
        .then(data => {
            uploadSupportState.known = true;
            uploadSupportState.supported =
                !!(data && data.ok && Number(data.version) >= 2);
        })
        .catch(() => {
            uploadSupportState.known = true;
            uploadSupportState.supported = false;
        });
}



/*
====================================================
إرسال البلاغ — إعادة محاولة آمنة بلا تكرار
====================================================
المشكلة التي كانت تسبّب «وصول متأخر أو عدم وصول»:
  • كل محاولة إرسال كانت تولّد remoteId جديداً، ومهلة العميل 20 ثانية فقط.
  • عند بطء الخادم (Apps Script) ينتهي الطلب عند المتصفح بينما يستمر
    التنفيذ البعيد ويضيف السطر فعلاً، فيرى المبلّغ «لم يُرسل» ويعيد
    الإرسال برقم جديد ⇒ أمر عمل مكرر، أو يغلق الصفحة فيضيع.
الحل (بلا تغيير في الواجهة ولا في الوجهة):
  • رقم بلاغ واحد ثابت لكل نموذج (pendingRemoteId) يُعاد استخدامه في كل
    محاولة، فيتعرف الخادم على التكرار بنفس remoteId ويرد ok بلا ازدواج.
  • إعادة المحاولة تلقائياً عند الفشل المؤقت فقط (شبكة/مهلة/5xx).
  • لا يُعلَن النجاح إلا بعد تأكيد ok:true من الخادم.
*/

let pendingRemoteId = null;
let lastSuccessfulTransport = '';

function isUnconfirmedStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return status === 'queued' || status === 'pending' || status === 'unknown';
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function postReportOnce(endpoint, payload, timeoutMs) {

    const abortController =
        typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;

    const abortTimer =
        abortController
            ? setTimeout(function () { abortController.abort(); }, timeoutMs)
            : null;

    let resp;

    try {
        resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8'
            },
            body: JSON.stringify(payload),
            signal: abortController ? abortController.signal : undefined
        });
    } catch (fetchError) {
        const err = new Error(
            fetchError && fetchError.name === 'AbortError'
                ? 'انتهت مهلة الاتصال بالخادم.'
                : 'تعذّر الوصول إلى الخادم.'
        );
        err.transient = true; // شبكة/مهلة ⇒ يُعاد المحاولة
        throw err;
    } finally {
        if (abortTimer !== null) clearTimeout(abortTimer);
    }

    let respText = '';
    try {
        respText = await resp.text();
    } catch (e) {
        respText = '';
    }

    let parsed = null;
    if (respText) {
        // 1.7: JSON.parse محمي — رد HTML/فارغ غير متوقع لا يرمي استثناءً غامضاً.
        try {
            parsed = JSON.parse(respText);
        } catch (parseError) {
            parsed = null;
        }
    }

    if (resp.ok && parsed && parsed.ok === true) {
        const expectedRemoteId = String(payload && payload.remoteId || '');
        const isLocal = endpoint === API_URL || String(endpoint || '').indexOf('/api/') === 0;
        const transport = isLocal ? 'local' : 'gas';

        // queued is a durable local acknowledgement only. A GAS response with
        // queued:true is never a delivery confirmation and must be rejected.
        if (parsed.queued === true) {
            if (isLocal) {
                lastSuccessfulTransport = 'local';
                return parsed;
            }
            const err = new Error('أعاد Google Apps Script queued:true بدلاً من تأكيد التسليم.');
            err.transient = true;
            throw err;
        }

        // One validator for every delivery path. It rejects missing/mismatched
        // remoteId, delivered:false, queued:true, pending/unknown statuses and
        // contradictory status/delivered combinations.
        const confirms = window.ReporterOutbox && typeof window.ReporterOutbox.responseConfirmsDelivery === 'function'
            ? window.ReporterOutbox.responseConfirmsDelivery(expectedRemoteId, parsed, transport)
            : false;
        if (!confirms) {
            const err = new Error('رد الخادم لم يؤكد التسليم أو كان متناقضاً.');
            err.transient = true; // يُعاد بنفس remoteId
            throw err;
        }
        lastSuccessfulTransport = transport;
        return parsed;
    }

    if (!resp.ok || !parsed || parsed.ok !== true) {
        const err = new Error(
            parsed && parsed.error
                ? String(parsed.error)
                : 'لم يصل البلاغ إلى الخادم'
        );
        // رد 5xx أو رد غير قابل للتحليل = عابر (يُعاد). رد 4xx بمحتوى JSON
        // واضح = رفض نهائي من الخادم (لا فائدة من إعادة المحاولة).
        err.transient = !parsed || resp.status >= 500;
        // المسار غير موجود (نشر خارجي بلا خادمنا، 404/405، أو رد غير JSON)
        // ⇒ لا فائدة من تكرار نفس المسار؛ ننتقل للمسار البديل (GAS).
        err.endpointMissing = (resp.status === 404 || resp.status === 405 || !parsed);
        throw err;
    }

    return parsed;
}

async function postReportWithRetry(payload) {

    const MAX_ATTEMPTS = 3;
    const TIMEOUT_MS = 25000; // أطول من مهلة الخادم الواقعية
    let lastError = null;

    // نجرّب خادمنا المحلي أولاً، وعند تعذّره (نشر خارجي/خادم متوقف) نسقط تلقائياً
    // إلى Google Apps Script. الرفض النهائي الواضح (4xx JSON) يتوقف فوراً بلا تبديل.
    for (let e = 0; e < API_ENDPOINTS.length; e++) {
        const endpoint = API_ENDPOINTS[e];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return await postReportOnce(endpoint, payload, TIMEOUT_MS);
            } catch (error) {
                lastError = error;
                if (!error.transient) throw error;   // رفض نهائي واضح من الخادم
                if (error.endpointMissing) break;    // المسار غير موجود ⇒ جرّب البديل
                if (attempt === MAX_ATTEMPTS) break; // استُنفدت المحاولات ⇒ جرّب البديل
                await sleep(attempt * 1500);
            }
        }
    }

    throw lastError;
}

$('report-form')
.addEventListener(
    'submit',
    async event => {

        event.preventDefault();


        const button =
            $('submit');


        button.disabled = true;

        button.textContent =
            'جارٍ إرسال البلاغ...';

        // هل يتوفّر طابور محلي (IndexedDB)؟ عندها نحفظ البلاغ ونرسله في الخلفية.
        const useOutbox =
            !!(window.ReporterOutbox && window.ReporterOutbox.available());


        try {


            /*
            رقم ثابت للبلاغ: يبقى نفسه لو أعاد المبلّغ المحاولة، فيمنع
            الخادمُ تكرارَ البلاغ (كشف remoteId الموجود).
            */

            if (!pendingRemoteId) {

                pendingRemoteId =
                    'PUB-' +
                    Date.now() +
                    '-' +
                    Math.random()
                    .toString(36)
                    .slice(2, 10);

            }

            let remoteId =
                pendingRemoteId;

            let submissionFingerprint = '';



            /*
            قراءة المرفق
            */

            const file =
                await fileToDataUrl(
                    $('attachment').files[0]
                );



            /*
            تجهيز البيانات
            */

            const now =
                new Date();

            // تاريخ/وقت البلاغ يُسجّلان بتوقيت السعودية صراحةً، لا بتوقيت
            // جهاز المبلّغ. يبقى submittedAt بالـ UTC كما هو.
            const riyadhDateTime =
                getRiyadhDateParts(now);


            const payload = {

                action: 'submit',

                remoteId: remoteId,

                extNo:
                    $('reporterPhone')
                    .value
                    .trim(),

                reporter:
                    $('reporter')
                    .value
                    .trim(),

                reporterPhone:
                    $('reporterPhone')
                    .value
                    .trim(),

                dept:
                    ($('dept').value === '__custom__' ? $('dept-custom').value.trim() : $('dept').value.trim()),

                location:
                    $('location')
                    .value
                    .trim(),

                spec:
                    (document.querySelector('input[name="spec"]:checked') || {}).value || '',

                priority:
                    $('priority')
                    .value,

                desc:
                    $('desc')
                    .value
                    .trim(),

                attachment:
                    file,

                date:
                    riyadhDateTime.date,

                time:
                    riyadhDateTime.time,

                submittedAt:
                    now.toISOString()

            };


            /*
            R2: نثبّت remoteId ونحفظ بصمة البلاغ قبل أي محاولة إرسال. إذا
            أعيد تحميل الصفحة وفشل GAS/ضاع رده، فسيُستخدم الرقم نفسه عند
            إعادة إدخال البيانات المطابقة، ولا يُولَّد رقم جديد لبلاغ مختلف.
            */
            if (window.ReporterOutbox && typeof window.ReporterOutbox.prepareSubmission === 'function') {
                const prepared = await window.ReporterOutbox.prepareSubmission(payload, remoteId);
                remoteId = prepared.remoteId;
                payload.remoteId = remoteId;
                submissionFingerprint = prepared.fingerprint;
                pendingRemoteId = remoteId;
                // Direct delivery without durable identity storage cannot be
                // verified after reload. Refuse it instead of losing the
                // report's receipt or reopening it under a new id.
                if (!useOutbox && !prepared.persisted) {
                    throw new Error('تعذّر حفظ هوية البلاغ محلياً. لا يمكن ضمان التحقق بعد إعادة التحميل؛ لن يُرسل البلاغ في هذا الوضع.');
                }
            }
            rememberLastReport(remoteId, 'pending');


            /*
            5.4: الملف يُرفع أولاً إلى Google Drive ليصبح رابطاً — فتبقى حزمة
            الإرسال صغيرة وسريعة (كانت الصورة الحقيقية تبطّئ الإرسال 5-13 ثانية).
            إن كانت النسخة المنشورة قديمة (لا تدعم الرفع — كشفها الفحص في الخلفية)
            نتجاوز محاولة الرفع فوراً ونرسل المرفق مضمّناً: لا نضيّع ~6 ثوانٍ في
            طلب سيعود «Invalid action». وإن تعذّر الرفع لأي سبب نعود للإرسال
            المضمّن — لا يضيع البلاغ أبداً.
            */

            if (!useOutbox && file && !(uploadSupportState.known && !uploadSupportState.supported)) {

                try {

                    const uploadController =
                        typeof AbortController !== 'undefined'
                            ? new AbortController()
                            : null;

                    const uploadTimer =
                        uploadController
                            ? setTimeout(
                                function () {
                                    uploadController.abort();
                                },
                                20000)
                            : null;

                    try {

                        const uploadResp =
                            await fetch(
                                '/api/attachment/upload',
                                {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type':
                                            'application/json'
                                    },
                                    body: JSON.stringify({
                                        action: 'uploadAttachment',
                                        fileName: file.name,
                                        mimeType: file.type,
                                        dataUrl: file.dataUrl
                                    }),
                                    signal:
                                        uploadController
                                            ? uploadController.signal
                                            : undefined
                                }
                            );

                        let uploadData =
                            null;

                        try {

                            uploadData =
                                await uploadResp.json();

                        } catch (jsonError) {

                            uploadData =
                                null;

                        }

                        if (
                            uploadResp.ok
                            && uploadData
                            && uploadData.ok
                            && uploadData.url
                        ) {

                            payload.attachmentUrl =
                                uploadData.url;

                            delete payload.attachment;

                        }

                    } finally {

                        if (uploadTimer) {
                            clearTimeout(uploadTimer);
                        }

                    }

                } catch (uploadError) {

                    console.warn(
                        'تعذّر رفع المرفق كرابط، سيُرسَل مضمّناً:',
                        uploadError
                    );

                }

            }



            /*
            المسار السريع: إن توفّر طابور محلي نحفظ البلاغ فوراً وننتقل لصفحة
            النجاح بلا انتظار أي اتصال — يتولّى الطابور الإرسال في الخلفية مع
            إعادة المحاولة حتى لا يضيع البلاغ إن تعذّر الاتصال.
            */

            if (useOutbox) {

                try {

                    await window.ReporterOutbox.enqueue(payload);

                    // البلاغ أصبح في الطابور المحلي الدائم؛ نُنهي بيانات
                    // الاستئناف فقط بعد نجاح الحفظ، ولا نمس أي سجل آخر.
                    if (window.ReporterOutbox && typeof window.ReporterOutbox.clearPendingSubmission === 'function') {
                        window.ReporterOutbox.clearPendingSubmission(remoteId);
                    }
                    pendingRemoteId = null;
                    rememberLastReport(remoteId, 'queued');
                    resetReportFormAfterSubmit();

                    setStatus(
                        'تم استلام بلاغك وسيُرسَل تلقائياً...',
                        'success'
                    );

                    // مهلة قصيرة كي تُسجّل تحليلات reporter.2.js قبل الانتقال.
                    // الرقم في query يربط صفحة النجاح بعملية الإرسال نفسها،
                    // لا بآخر تسليم قديم في الطابور.
                    setTimeout(function () {
                        window.location.href = 'success.html?remoteId=' + encodeURIComponent(remoteId);
                    }, 320);

                    return;

                } catch (outboxError) {

                    console.warn('تعذّر الحفظ المحلي، سيُرسَل مباشرةً:', outboxError);

                }

            }

            /*
            إرسال إلى Google Apps Script

            نستخدم text/plain حتى لا يرسل المتصفح preflight CORS.
            postReportWithRetry تعيد المحاولة عند الفشل المؤقت بنفس رقم البلاغ
            (remoteId) فلا يتكرر البلاغ، وتتأكد من ok:true قبل إعلان النجاح.
            */

            const result =
                await postReportWithRetry(payload);



            /*
            نجاح الإرسال
            */

            const queued = !!(result && result.queued === true);
            // الرد تم التحقق من مطابقته لـ remoteId في postReportOnce؛
            // نبقى على الرقم الأصلي ولا نستبدله برقم قادم من الشبكة.
            const finalRemoteId = remoteId;

            // R1/R4: الإيصال يُكتب قبل مسح هوية البلاغ. إذا تعذّر حفظه
            // فلا ننتقل إلى صفحة نجاح ولا نمسح pending؛ يبقى البلاغ قابلاً
            // لإعادة المحاولة بالرقم نفسه.
            if (!queued) {
                if (!window.ReporterOutbox || typeof window.ReporterOutbox.recordVerifiedDelivery !== 'function') {
                    throw new Error('تعذّر حفظ إيصال التسليم محلياً؛ أُبقي البلاغ قيد التحقق.');
                }
                const receiptSaved = await window.ReporterOutbox.recordVerifiedDelivery(
                    finalRemoteId,
                    result,
                    lastSuccessfulTransport,
                    submissionFingerprint
                );
                if (!receiptSaved) {
                    throw new Error('تعذّر حفظ إيصال التسليم محلياً؛ أُبقي البلاغ قيد التحقق ولم يُمسح.');
                }
            }

            if (window.ReporterOutbox && typeof window.ReporterOutbox.clearPendingSubmission === 'function') {
                window.ReporterOutbox.clearPendingSubmission(finalRemoteId);
            }
            pendingRemoteId = null;
            rememberLastReport(finalRemoteId, queued ? 'queued' : 'delivered');

            setStatus(
                queued
                    ? 'تم استلام البلاغ وسيُرسَل تلقائياً. رقم البلاغ: ' + finalRemoteId
                    : 'تم إرسال البلاغ بنجاح. رقم البلاغ: ' + finalRemoteId,
                'success'
            );


            /*
            تنظيف النموذج
            */

            resetReportFormAfterSubmit();


            /*
            5.4: كان ينتظر 400ms إضافية قبل الانتقال لصفحة النجاح. لا داعي
            للتأخير: نجاح الإرسال مؤكَّد، وننتقل فوراً لصفحة النجاح.
            */

            window.location.href =
                'success.html?remoteId=' + encodeURIComponent(finalRemoteId);



        } catch (error) {


            console.error(error);


            setStatus(
                error.message ||
                'تعذر إرسال البلاغ.',
                'error'
            );


        } finally {


            button.disabled = false;

            button.textContent =
                'إرسال البلاغ';

        }

    }
);

