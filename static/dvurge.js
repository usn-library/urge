// Enable buttons when the URL is valid
async function checkUrl() {
    const url = document.getElementById('privaturl').value;
    if (!url) {
        document.getElementById('fetchButton').disabled = true;
        return;
    }
    
    try {
        const urlObj = new URL(url);
        if (!urlObj.pathname.includes('previewurl.xhtml')) {
            showErrorMessage('Invalid Dataverse preview URL. URL must contain "previewurl.xhtml".');
            document.getElementById('fetchButton').disabled = true;
            return;
        }
        const dataverseBaseUrl = getSelectedDataverseBaseUrl();
        const dataverseBase = new URL(dataverseBaseUrl);
        const basePath = dataverseBase.pathname.replace(/\/+$/, '');
        const sameHost = urlObj.host.toLowerCase() === dataverseBase.host.toLowerCase();
        const pathMatches = !basePath || urlObj.pathname === basePath || urlObj.pathname.startsWith(`${basePath}/`);

        if (!sameHost || !pathMatches) {
            showErrorMessage('Private URL must belong to the selected Dataverse address.');
            document.getElementById('fetchButton').disabled = true;
            return;
        }

        currentDataverseBaseUrl = dataverseBaseUrl;
        document.getElementById('fetchButton').disabled = false;
    } catch (e) {
        showErrorMessage(e.message || 'Invalid URL format');
        document.getElementById('fetchButton').disabled = true;
    }
}

// Cached Dataverse metadata from the last import
let dataverseMetadata = {};

// Last Data Import API payload; Sharing fetch buttons reuse this cache to avoid 403s
let cachedDataverseApiResponse = null;
let isDataverseImportReady = false;
let isDmpImportReady = false;
let dmpCompareData = null;
let dmpCompareSource = '';
let selectedSiktDatasetIndex = null;
let selectedDswDatasetIndex = null;

const compareFieldConfig = [
    { key: 'title', label: 'Title' },
    { key: 'description', label: 'Description' },
    { key: 'descriptionOfDataset', label: 'Description of Dataset' },
    { key: 'doi', label: 'DOI' },
    { key: 'name', label: 'Contact Name' },
    { key: 'email', label: 'Email' },
    { key: 'dataType', label: 'Data Type' }
];

function normalizeComparableValue(value) {
    if (value == null) return '';
    if (Array.isArray(value)) {
        return value.map(function (item) {
            return (item == null ? '' : String(item)).trim();
        }).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch (_) {
            return String(value);
        }
    }
    return String(value).trim();
}

function escapeHtmlForCompare(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeDataverseCompareData() {
    const source = cachedDataverseApiResponse || dataverseMetadata || {};
    return {
        title: normalizeComparableValue(source.title),
        description: normalizeComparableValue(source.description),
        descriptionOfDataset: normalizeComparableValue(source.description),
        doi: normalizeComparableValue(source.doi),
        name: normalizeComparableValue(source.author || source.contact_name),
        email: normalizeComparableValue(source.email),
        dataType: normalizeComparableValue(source.dataType || source.subject)
    };
}

function normalizeSiktCompareData(selectedDataset, siktRoot) {
    const creator = (siktRoot && siktRoot.createdBy) || (jsonData && jsonData.createdBy) || {};
    return {
        title: normalizeComparableValue(selectedDataset && selectedDataset.title),
        description: normalizeComparableValue(selectedDataset && selectedDataset.description),
        descriptionOfDataset: normalizeComparableValue(selectedDataset && selectedDataset.description),
        doi: '',
        name: normalizeComparableValue(creator.name),
        email: normalizeComparableValue(creator.email),
        dataType: normalizeComparableValue((selectedDataset && selectedDataset.dataTypes) || [])
    };
}

function normalizeDswCompareData(ctx, itemPrefix) {
    const pids = (ctx && ctx.produceFieldIds) || {};
    const title = dswFirstScalarFromMany(ctx.replies, itemPrefix, pids.datasetNameUuids || [], ctx.km);
    const description = dswFirstScalarFromMany(ctx.replies, itemPrefix, pids.descriptionUuids || [], ctx.km);
    const ids = dswCollectIdentifierStringsForLists(ctx.replies, itemPrefix, pids.identifiersListUuids || []);
    const doiVal = dswPickBestIdentifier(ids);
    const dataTypeStr = dswFirstScalarFromMany(ctx.replies, itemPrefix, pids.dataTypeUuids || [], ctx.km);
    const listEntry = ctx.replies[ctx.contributorsListPrefix];
    const cItems = (listEntry && listEntry.value && listEntry.value.type === 'ItemListReply')
        ? (listEntry.value.value || [])
        : [];
    const contactAns = dswCollectAnswerUuidsForLabel(ctx.km, 'Contact Person');
    const contactItemPrefix = dswFindContactPersonItemPrefix(
        ctx.replies,
        ctx.contributorsListPrefix,
        cItems,
        ctx.contribFieldIds || { role: [] },
        contactAns
    );
    let name = '';
    let email = '';
    if (contactItemPrefix) {
        const idsForContact = ctx.contribFieldIds || {};
        name = dswFirstScalarFromMany(ctx.replies, contactItemPrefix, idsForContact.name || [], ctx.km);
        email = dswFirstScalarFromMany(ctx.replies, contactItemPrefix, idsForContact.email || [], ctx.km);
    }
    if (!name && !email) {
        const cb = (ctx.questionnaire && ctx.questionnaire.createdBy) || {};
        const fn = cb.firstName || '';
        const ln = cb.lastName || '';
        name = (ln && fn) ? (ln + ', ' + fn) : (fn || ln || '');
        email = cb.email || '';
    }
    return {
        title: normalizeComparableValue(title),
        description: normalizeComparableValue(description),
        descriptionOfDataset: normalizeComparableValue(description),
        doi: normalizeComparableValue(doiVal),
        name: normalizeComparableValue(name),
        email: normalizeComparableValue(email),
        dataType: normalizeComparableValue(dataTypeStr)
    };
}

function hasComparePrerequisites() {
    const hasDataverseApiToken = (document.getElementById('apiTokenInput')?.value || '').trim();
    const hasDataversePidOrDoi = (document.getElementById('doiInput')?.value || '').trim();
    const hasDataverseConnection = Boolean(hasDataverseApiToken && hasDataversePidOrDoi);
    const hasFigshareConnection = Boolean(
        figshareSelectedDraft &&
        (cachedDataverseApiResponse || dataverseMetadata) &&
        Object.keys(cachedDataverseApiResponse || dataverseMetadata || {}).length
    );
    const hasZenodoConnection = Boolean(
        zenodoSelectedDraft &&
        (cachedDataverseApiResponse || dataverseMetadata) &&
        Object.keys(cachedDataverseApiResponse || dataverseMetadata || {}).length
    );
    const apiToken = (document.getElementById('apiTokenInput')?.value || '').trim();
    const pidOrDoi = (document.getElementById('doiInput')?.value || '').trim();
    const hasSiktJson = Boolean(document.getElementById('jsonInput')?.files?.length);
    const hasDswJson = Boolean(document.getElementById('jsonInputDsw')?.files?.length);
    return Boolean((hasDataverseConnection || hasFigshareConnection || hasZenodoConnection) && (hasSiktJson || hasDswJson));
}

function updateDataCompareButtonVisibility() {
    const wrap = document.getElementById('dataCompareActionWrap');
    const btn = document.getElementById('dataCompareButton');
    if (wrap) wrap.style.display = '';
    if (!btn) return;
    btn.disabled = !hasComparePrerequisites();
}

function markDataverseImportReady() {
    isDataverseImportReady = true;
    updateDataCompareButtonVisibility();
}

function markDmpImportReady(source, normalizedData) {
    isDmpImportReady = true;
    dmpCompareSource = source || '';
    dmpCompareData = normalizedData || {};
    updateDataCompareButtonVisibility();
}

function renderDataCompareModal() {
    const body = document.getElementById('dataCompareTableBody');
    if (!body) return;
    const dmpData = dmpCompareData || {};
    const dataverseData = normalizeDataverseCompareData();
    const rows = compareFieldConfig.filter(function (field) {
        return Boolean(normalizeComparableValue(dmpData[field.key])) &&
            Boolean(normalizeComparableValue(dataverseData[field.key]));
    });
    if (!rows.length) {
        body.innerHTML = '<tr><td colspan="3" class="text-muted">No common data found between DMP and Dataverse imports.</td></tr>';
        return;
    }
    body.innerHTML = rows.map(function (field) {
        const dmpValue = escapeHtmlForCompare(normalizeComparableValue(dmpData[field.key]));
        const dataverseValue = escapeHtmlForCompare(normalizeComparableValue(dataverseData[field.key]));
        return '<tr>' +
            '<th scope="row">' + escapeHtmlForCompare(field.label) + '</th>' +
            '<td>' + dmpValue + '</td>' +
            '<td>' + dataverseValue + '</td>' +
            '</tr>';
    }).join('');
}

function readSelectedFileAsText(fileInputId) {
    return new Promise(function (resolve, reject) {
        const input = document.getElementById(fileInputId);
        const file = input && input.files && input.files[0];
        if (!file) {
            resolve('');
            return;
        }
        const reader = new FileReader();
        reader.onload = function (event) {
            resolve(String((event && event.target && event.target.result) || ''));
        };
        reader.onerror = function () {
            reject(new Error('An error occurred while reading the selected JSON file.'));
        };
        reader.readAsText(file);
    });
}

async function fetchDataverseCompareDataFromInputs() {
    const apiToken = (document.getElementById('apiTokenInput')?.value || '').trim().split(/\s+/).join('');
    const doi = (document.getElementById('doiInput')?.value || '').trim();
    const dataverseBaseUrl = getSelectedDataverseBaseUrl();
    if (!apiToken || !doi) {
        throw new Error('Dataverse API token and PID/DOI are required.');
    }
    const response = await fetch('/fetch_dataset_api', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            doi: doi,
            api_token: apiToken,
            dataverse_base_url: dataverseBaseUrl
        })
    });
    if (!response.ok) {
        throw new Error(`Dataverse request failed (HTTP ${response.status})`);
    }
    const data = await response.json();
    if (data.error) {
        throw new Error(data.error);
    }
    cachedDataverseApiResponse = data;
    dataverseMetadata = Object.assign({}, dataverseMetadata, data);
    markDataverseImportReady();
}

async function prepareRepositoryCompareDataForModal() {
    const hasFigshareConnection = Boolean(
        figshareSelectedDraft &&
        (cachedDataverseApiResponse || dataverseMetadata) &&
        Object.keys(cachedDataverseApiResponse || dataverseMetadata || {}).length
    );
    const hasZenodoConnection = Boolean(
        zenodoSelectedDraft &&
        (cachedDataverseApiResponse || dataverseMetadata) &&
        Object.keys(cachedDataverseApiResponse || dataverseMetadata || {}).length
    );
    if (hasFigshareConnection) {
        markDataverseImportReady();
        return;
    }
    if (hasZenodoConnection) {
        markDataverseImportReady();
        return;
    }
    await fetchDataverseCompareDataFromInputs();
}

async function buildDmpCompareDataFromSelectedJson() {
    const siktText = await readSelectedFileAsText('jsonInput');
    if (siktText) {
        const siktRoot = JSON.parse(siktText);
        const collections = (((siktRoot || {}).revision || {}).document || {}).collections || [];
        if (!collections.length) {
            throw new Error('SIKT DMP JSON does not contain dataset collections.');
        }
        let resolvedIndex = selectedSiktDatasetIndex;
        if (resolvedIndex == null || resolvedIndex < 0 || resolvedIndex >= collections.length) {
            const currentTitle = (document.getElementById('title')?.value || '').trim().toLowerCase();
            if (currentTitle) {
                const inferred = collections.findIndex(function (c) {
                    return String((c && c.title) || '').trim().toLowerCase() === currentTitle;
                });
                if (inferred >= 0) {
                    resolvedIndex = inferred;
                }
            }
        }
        if (resolvedIndex == null || resolvedIndex < 0 || resolvedIndex >= collections.length) {
            resolvedIndex = 0;
        }
        selectedSiktDatasetIndex = resolvedIndex;
        const selectedDataset = collections[resolvedIndex];
        const normalized = normalizeSiktCompareData(selectedDataset, siktRoot);
        markDmpImportReady('sikt', normalized);
        return;
    }

    const dswText = await readSelectedFileAsText('jsonInputDsw');
    if (!dswText) {
        throw new Error('Please select a DMP/ELIXIR JSON file first.');
    }
    const dsw = JSON.parse(dswText);
    const qs = dsw.questionnaire;
    const km = dsw.knowledgeModel;
    if (!qs || !qs.replies || !km || !km.entities) {
        throw new Error('Invalid DSW JSON format.');
    }
    let listPrefix = dswResolveListReplyPrefix(qs.replies, km, DSW_PRODUCING_LIST_TITLE);
    if (!listPrefix) listPrefix = DSW_FALLBACK_DATASET_LIST_PREFIX;
    const listEntry = qs.replies[listPrefix];
    const itemUuids = (listEntry && listEntry.value && listEntry.value.type === 'ItemListReply')
        ? (listEntry.value.value || [])
        : [];
    if (!itemUuids.length) {
        throw new Error('No dataset found in selected DSW JSON.');
    }
    if (selectedDswDatasetIndex == null || selectedDswDatasetIndex < 0 || selectedDswDatasetIndex >= itemUuids.length) {
        selectedDswDatasetIndex = 0;
    }
    const producingQ = dswFindListQuestionUuidByTitle(km, DSW_PRODUCING_LIST_TITLE);
    const produceFieldIds = dswEnsureProducingFieldIds(km, producingQ);
    const contributorsListPrefix = dswResolveListReplyPrefix(qs.replies, km, DSW_CONTRIBUTORS_LIST_TITLE);
    const contribQ = dswFindListQuestionUuidByTitle(km, DSW_CONTRIBUTORS_LIST_TITLE);
    const contribFieldIds = (contributorsListPrefix && contribQ) ? dswBuildContributorFieldIds(km, contribQ) : null;
    const ctx = {
        listPrefix: listPrefix,
        itemUuids: itemUuids,
        replies: qs.replies,
        km: km,
        questionnaire: qs,
        produceFieldIds: produceFieldIds,
        contributorsListPrefix: contributorsListPrefix,
        contribFieldIds: contribFieldIds
    };
    const itemPrefix = listPrefix + '.' + itemUuids[selectedDswDatasetIndex] + '.';
    const normalized = normalizeDswCompareData(ctx, itemPrefix);
    markDmpImportReady('dsw', normalized);
}

async function openDataCompareModal() {
    if (!hasComparePrerequisites()) {
        showErrorMessage('Data Compare requires Dataverse (API token + PID/DOI) or a selected Figshare or Zenodo draft, plus a selected DMP/ELIXIR JSON file.');
        return;
    }
    try {
        showLoadingMessage();
        await prepareRepositoryCompareDataForModal();
        await buildDmpCompareDataFromSelectedJson();
        renderDataCompareModal();
        const modalEl = document.getElementById('dataCompareModal');
        if (!modalEl) {
            throw new Error('Data Compare modal element was not found in the page.');
        }
        if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
        } else if (typeof window.$ === 'function') {
            window.$('#dataCompareModal').modal('show');
        } else {
            throw new Error('Modal library is not available (Bootstrap/jQuery).');
        }
        showSuccessMessage('Comparison data loaded successfully.');
    } catch (error) {
        console.error('Data compare error:', error);
        const msg = error && error.message ? error.message : 'Could not prepare comparison data.';
        showErrorMessage(msg);
        if (/select a dataset first/i.test(msg)) {
            alert(msg);
        }
    }
}

/** Sidebar textarea checklist: refresh after programmatic value changes (import, sharing buttons, etc.). */
function invokeUrgeSidebarTextareaRefresh() {
    if (typeof window.refreshUrgeSidebarTextareaStates === 'function') {
        window.refreshUrgeSidebarTextareaStates();
        // Some imports/autofill paths update fields asynchronously; re-check shortly after.
        window.requestAnimationFrame(() => {
            if (typeof window.refreshUrgeSidebarTextareaStates === 'function') {
                window.refreshUrgeSidebarTextareaStates();
            }
        });
        setTimeout(() => {
            if (typeof window.refreshUrgeSidebarTextareaStates === 'function') {
                window.refreshUrgeSidebarTextareaStates();
            }
        }, 180);
        setTimeout(() => {
            if (typeof window.refreshUrgeSidebarTextareaStates === 'function') {
                window.refreshUrgeSidebarTextareaStates();
            }
        }, 700);
    }
}

// Shared UI state
let currentApiToken = '';
let currentDoi = '';
let isDataverseConnected = false;
const DEFAULT_DATAVERSE_BASE_URL = 'https://dataverse.no';
let currentDataverseBaseUrl = DEFAULT_DATAVERSE_BASE_URL;

// Reflects the Dataverse connection state inside the "Send to Dataverse"
// button: a small green light + "Connected" label when the API token and DOI
// have been entered and a connection was successfully established, a small red
// light + "Not connected" label otherwise.
function setDataverseConnectionStatus(connected) {
    isDataverseConnected = Boolean(connected);
    const btn = document.getElementById('sendDataverseBtn');
    const text = document.getElementById('dataverseConnText');
    if (!btn) return;
    btn.classList.toggle('conn-status--on', isDataverseConnected);
    btn.classList.toggle('conn-status--off', !isDataverseConnected);
    btn.title = isDataverseConnected ? 'Connected to Dataverse' : 'Not connected to Dataverse';
    if (text) {
        text.textContent = isDataverseConnected ? 'Connected' : 'Not connected';
    }
}

// Reflects the Figshare state inside the "Send to Figshare" button: the button
// is shown once a personal token has been entered, and its connection light
// turns green ("Connected") once a draft has been selected, red otherwise.
function setFigshareSendButtonState() {
    const btn = document.getElementById('sendFigshareBtn');
    if (!btn) return;
    const tokenInput = document.getElementById('figshareApiKeyInput');
    const hasToken = Boolean(tokenInput && (tokenInput.value || '').trim());
    btn.classList.toggle('d-none', !hasToken);

    const connected = Boolean(figshareSelectedDraft);
    btn.classList.toggle('conn-status--on', connected);
    btn.classList.toggle('conn-status--off', !connected);
    btn.title = connected ? 'Connected to Figshare' : 'Not connected to Figshare';
    const text = document.getElementById('figshareConnText');
    if (text) {
        text.textContent = connected ? 'Connected' : 'Not connected';
    }
}

// --- QR Code (DOI + Contact) ---
let _qrModal = null;
let _qrObjectUrl = null;
let _qrDownloadFilename = 'qr.png';
let _qrImageDataUrl = null;
const _qrRenderSize = 1024;

function _getQrModal() {
    const el = document.getElementById('qrModal');
    if (!el) return null;
    if (_qrModal) return _qrModal;
    _qrModal = new bootstrap.Modal(el);
    return _qrModal;
}

function _setQrModalError(message) {
    const errorEl = document.getElementById('qrModalError');
    if (!errorEl) return;
    if (!message) {
        errorEl.classList.add('d-none');
        errorEl.textContent = '';
        return;
    }
    errorEl.classList.remove('d-none');
    errorEl.textContent = message;
}

function _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read QR image data.'));
        reader.readAsDataURL(blob);
    });
}

async function _setQrModalImageFromBlob(blob, filename) {
    const imgEl = document.getElementById('qrModalImage');
    const downloadBtn = document.getElementById('qrModalDownloadBtn');
    if (!imgEl || !downloadBtn) return;

    if (_qrObjectUrl) {
        URL.revokeObjectURL(_qrObjectUrl);
        _qrObjectUrl = null;
    }

    _qrDownloadFilename = filename || 'qr.png';
    _qrObjectUrl = URL.createObjectURL(blob);
    _qrImageDataUrl = await _blobToDataUrl(blob);
    imgEl.src = _qrImageDataUrl;

    downloadBtn.disabled = false;
    downloadBtn.onclick = () => {
        const a = document.createElement('a');
        a.href = _qrObjectUrl;
        a.download = _qrDownloadFilename;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
}

function _renderQrPngBlob(data, size = _qrRenderSize) {
    if (typeof QRCode === 'undefined') {
        return Promise.reject(new Error('QR generation is unavailable in this browser.'));
    }

    const canvas = document.createElement('canvas');
    return new Promise((resolve, reject) => {
        QRCode.toCanvas(canvas, data, {
            errorCorrectionLevel: 'M',
            width: size,
            margin: 4,
        }, (err) => {
            if (err) {
                reject(err);
                return;
            }
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                    return;
                }
                reject(new Error('Could not create QR PNG.'));
            }, 'image/png');
        });
    });
}

function _normalizeDoiToUrl(rawDoi) {
    const v = (rawDoi || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    const doi = v.replace(/^doi:\s*/i, '');
    return `https://doi.org/${doi}`;
}

function _splitName(raw) {
    const value = (raw || '').trim();
    if (!value) return { given: '', family: '' };
    if (value.includes(',')) {
        const parts = value.split(',');
        const family = (parts[0] || '').trim();
        const given = (parts.slice(1).join(',') || '').trim();
        return { given, family };
    }
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.length === 1) return { given: tokens[0], family: '' };
    return { given: tokens.slice(0, -1).join(' '), family: tokens[tokens.length - 1] };
}

function _buildVCard({ given, family, org, email }) {
    const safe = (s) => (s || '').replace(/\r?\n/g, ' ').trim();
    const g = safe(given);
    const f = safe(family);
    const o = safe(org);
    const e = safe(email);
    const fn = [g, f].filter(Boolean).join(' ').trim() || [f, g].filter(Boolean).join(' ').trim();

    const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:${f};${g};;;`,
        `FN:${fn}`,
    ];
    if (o) lines.push(`ORG:${o}`);
    if (e) lines.push(`EMAIL;TYPE=INTERNET:${e}`);
    lines.push('END:VCARD');
    return lines.join('\n');
}

async function showDoiQrModal() {
    const doiValue = document.getElementById('doi')?.value || '';
    const doiUrl = _normalizeDoiToUrl(doiValue);
    if (!doiUrl) {
        showErrorMessage?.('Please enter a DOI first.');
        return;
    }

    const modal = _getQrModal();
    if (!modal) return;

    _setQrModalError('');
    document.getElementById('qrModalLabel').textContent = 'DOI QR Code';
    const downloadBtn = document.getElementById('qrModalDownloadBtn');
    if (downloadBtn) downloadBtn.disabled = true;

    modal.show();

    try {
        const blob = await _renderQrPngBlob(doiUrl);
        await _setQrModalImageFromBlob(blob, 'doi-qr.png');
    } catch (err) {
        _setQrModalError(err?.message || 'Could not generate QR code.');
    }
}

async function showContactQrModal() {
    const nameValue = document.getElementById('name')?.value || '';
    const institutionValue = document.getElementById('institution')?.value || '';
    const emailValue = document.getElementById('email')?.value || '';

    if (!nameValue && !emailValue) {
        showErrorMessage?.('Please enter at least a name or an email first.');
        return;
    }

    const { given, family } = _splitName(nameValue);
    const vcard = _buildVCard({ given, family, org: institutionValue, email: emailValue });

    const modal = _getQrModal();
    if (!modal) return;

    _setQrModalError('');
    document.getElementById('qrModalLabel').textContent = 'Contact QR Code';
    const downloadBtn = document.getElementById('qrModalDownloadBtn');
    if (downloadBtn) downloadBtn.disabled = true;

    modal.show();

    try {
        const blob = await _renderQrPngBlob(vcard);
        await _setQrModalImageFromBlob(blob, 'contact-qr.png');
    } catch (err) {
        _setQrModalError(err?.message || 'Could not generate QR code.');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const doiBtn = document.getElementById('doiQrBtn');
    if (doiBtn) doiBtn.addEventListener('click', showDoiQrModal);

    const contactBtn = document.getElementById('contactQrBtn');
    if (contactBtn) contactBtn.addEventListener('click', showContactQrModal);

    const modalEl = document.getElementById('qrModal');
    if (modalEl) {
        modalEl.addEventListener('hidden.bs.modal', () => {
            _setQrModalError('');
            if (_qrObjectUrl) {
                URL.revokeObjectURL(_qrObjectUrl);
                _qrObjectUrl = null;
            }
            _qrImageDataUrl = null;
            const imgEl = document.getElementById('qrModalImage');
            if (imgEl) imgEl.removeAttribute('src');
        });
    }

    const compareBtn = document.getElementById('dataCompareButton');
    if (compareBtn) compareBtn.addEventListener('click', openDataCompareModal);
    ['apiTokenInput', 'doiInput', 'jsonInput', 'jsonInputDsw', 'figshareApiKeyInput', 'zenodoApiBaseUrlInput', 'zenodoAccessTokenInput'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', updateDataCompareButtonVisibility);
        el.addEventListener('change', updateDataCompareButtonVisibility);
    });
    updateDataCompareButtonVisibility();

    // Editing the token or DOI invalidates any previously established connection.
    ['apiTokenInput', 'doiInput'].forEach(function (id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', function () { setDataverseConnectionStatus(false); });
    });
    setDataverseConnectionStatus(false);
});

function isDataverseHostAllowed(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
    const allowed = (typeof window !== 'undefined' && Array.isArray(window.URGE_DATAVERSE_ALLOWED_HOSTS))
        ? window.URGE_DATAVERSE_ALLOWED_HOSTS
        : ['dataverse.no', 'demo.dataverse.no'];
    for (let i = 0; i < allowed.length; i++) {
        const listed = String(allowed[i] || '').toLowerCase().replace(/\.+$/, '');
        if (!listed) {
            continue;
        }
        if (host === listed || host.endsWith('.' + listed)) {
            return true;
        }
    }
    return false;
}

function normalizeDataverseBaseUrl(rawUrl) {
    let value = (rawUrl || '').trim();
    if (!value) {
        return '';
    }

    if (!/^https?:\/\//i.test(value)) {
        value = `https://${value}`;
    }

    const url = new URL(value);
    if (url.protocol !== 'https:') {
        throw new Error('Dataverse address must use HTTPS.');
    }

    url.hash = '';
    url.search = '';
    const cleanPath = url.pathname.replace(/\/+$/, '');
    if (!isDataverseHostAllowed(url.hostname)) {
        throw new Error('This Dataverse instance is not on the supported list.');
    }
    return `${url.origin}${cleanPath}`;
}

function buildDataverseUrl(baseUrl, relativePath) {
    const normalizedBaseUrl = normalizeDataverseBaseUrl(baseUrl) || DEFAULT_DATAVERSE_BASE_URL;
    const base = new URL(normalizedBaseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const suffix = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    return `${base.origin}${basePath}${suffix}`;
}

function getSelectedDataverseBaseUrl() {
    const useDefaultCheckbox = document.getElementById('useDefaultDataverseCheckbox');
    if (!useDefaultCheckbox || useDefaultCheckbox.checked) {
        return DEFAULT_DATAVERSE_BASE_URL;
    }

    const customInput = document.getElementById('customDataverseUrl');
    const customValue = normalizeDataverseBaseUrl(customInput?.value || '');
    if (!customValue) {
        throw new Error('Please enter the Dataverse address.');
    }

    return customValue;
}

function updateDataverseBaseUrlUi() {
    const useDefaultCheckbox = document.getElementById('useDefaultDataverseCheckbox');
    const customField = document.getElementById('customDataverseField');
    const customInput = document.getElementById('customDataverseUrl');

    if (!useDefaultCheckbox || !customField || !customInput) {
        return;
    }

    const useDefault = useDefaultCheckbox.checked;
    customField.style.display = useDefault ? 'none' : '';
    customInput.required = !useDefault;
    customInput.setCustomValidity('');

    if (useDefault) {
        currentDataverseBaseUrl = DEFAULT_DATAVERSE_BASE_URL;
    }
}

async function fetchDatasetFromPreview(previewUrl) {
    if (!previewUrl) {
        showErrorMessage('Preview URL required');
        return;
    }

    try {
        showLoadingMessage();
        const dataverseBaseUrl = getSelectedDataverseBaseUrl();
        currentDataverseBaseUrl = dataverseBaseUrl;

        const response = await fetch('/fetch_dataset_preview', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                preview_url: btoa(previewUrl),
                dataverse_base_url: btoa(dataverseBaseUrl),
                encoded: true
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Could not fetch data');
        }

        const data = await response.json();
        console.log('Received data:', data);
        
        // Cache metadata for later use
        dataverseMetadata = data;
        markDataverseImportReady();
        
        if (data.title) document.getElementById('title').value = data.title;
        if (data.doi) document.getElementById('doi').value = data.doi;
        if (data.author) document.getElementById('name').value = data.author;
        if (data.description) document.getElementById('description').value = data.description;
        if (data.institution) document.getElementById('institution').value = data.institution;
        if (data.email) document.getElementById('email').value = data.email;
        if (data.orcid) document.getElementById('orcid').value = data.orcid;
        
        // Resolve funding names via ROR when needed
        if (data.funding) {
            const processFunding = async (fundUrl) => {
                try {
                    // Strip ": Identifier" and extract the ROR id
                    const cleanUrl = fundUrl.split(': Identifier')[0];
                    const rorId = cleanUrl.split('/').pop();
                    if (!rorId) {
                        return `ROR ID not found`;
                    }

                    const response = await fetch(`https://api.ror.org/v1/organizations/${rorId}`);
                    if (response.ok) {
                        const data = await response.json();
                        if (data.name) {
                            return data.name;
                        }
                    }
                    return fundUrl;
                } catch (error) {
                    console.error('Funding lookup failed:', error);
                    return `${fundUrl} (Error: ${error.message})`;
                }
            };

            if (Array.isArray(data.funding)) {
                const fundingPromises = data.funding.map(processFunding);
                Promise.all(fundingPromises).then(results => {
                    dataverseMetadata.funding = results.join(', ');
                });
            } else if (typeof data.funding === 'string') {
                processFunding(data.funding).then(result => {
                    dataverseMetadata.funding = result;
                });
            }
        }
        
        let sharingText = '';
        
        if (data.license) {
            sharingText += `Licenses/Restrictions: ${data.license}\n\n`;
        }
        
        if (data.relatedPublication) {
            sharingText += 'Links to publications that cite or use the data:\n';
            if (Array.isArray(data.relatedPublication)) {
                data.relatedPublication.forEach(pub => {
                    sharingText += `- ${pub}\n`;
                });
            } else if (typeof data.relatedPublication === 'string') {
                const pubs = data.relatedPublication.split(';').map(p => p.trim());
                pubs.forEach(pub => {
                    sharingText += `- ${pub}\n`;
                });
            }
            sharingText += '\n';
        }
        
        if (data.relatedDataset) {
            sharingText += 'Links/relationships to related data sets:\n';
            if (Array.isArray(data.relatedDataset)) {
                data.relatedDataset.forEach(dataset => {
                    sharingText += `- ${dataset}\n`;
                });
            } else if (typeof data.relatedDataset === 'string') {
                const datasets = data.relatedDataset.split(';').map(d => d.trim());
                datasets.forEach(dataset => {
                    sharingText += `- ${dataset}\n`;
                });
            }
            sharingText += '\n';
        }
        
        if (data.dataSources) {
            sharingText += 'Data sources:\n';
            if (Array.isArray(data.dataSources)) {
                data.dataSources.forEach(source => {
                    sharingText += `- ${source}\n`;
                });
            } else if (typeof data.dataSources === 'string') {
                const sources = data.dataSources.split(';').map(s => s.trim());
                sources.forEach(source => {
                    sharingText += `- ${source}\n`;
                });
            }
        }

        document.getElementById('sharing').value = sharingText;
        
        if (data.files && Array.isArray(data.files)) {
            const fileInfoText = data.files.map(file => {
                let fileInfo = `${file.name || ''}`;
                if (file.type) fileInfo += ` (${file.type})`;
                if (file.size !== undefined && file.size !== null && file.size !== '') {
                    fileInfo += ` - ${formatSizeKB(file.size)}`;
                }
                if (file.deposit_date) fileInfo += ` - Upload Date: ${file.deposit_date}`;
                return fileInfo;
            }).join('\n');

            if (fileInfoText) {
                document.getElementById('fileinformation').value = fileInfoText;
            }
        }

        invokeUrgeSidebarTextareaRefresh();
        showSuccessMessage('Data loaded successfully!');
        
    } catch (error) {
        console.error('Error:', error);
        showErrorMessage(error.message);
    }
}

function fillFormWithPreviewData(data) {
    if (data.title) document.getElementById('title').value = data.title;
    if (data.description) document.getElementById('description').value = data.description;
    if (data.doi) document.getElementById('doi').value = data.doi;
    if (data.author) document.getElementById('name').value = data.author;
    if (data.contact_name && !data.author) document.getElementById('name').value = data.contact_name;
    if (data.institution) document.getElementById('institution').value = data.institution;
    if (data.email) document.getElementById('email').value = data.email;
    if (data.orcid) document.getElementById('orcid').value = data.orcid;
    
    if (data.subject && Array.isArray(data.subject)) {
        data.subject.forEach(subject => {
            const subjectLower = subject.toLowerCase();
            if (subjectLower.includes('survey') || subjectLower.includes('survy')) {
                document.getElementById('survyData').checked = true;
            }
            if (subjectLower.includes('observation')) {
                document.getElementById('observationData').checked = true;
            }
            if (subjectLower.includes('experimental')) {
                document.getElementById('experimentalData').checked = true;
            }
            if (subjectLower.includes('clinical')) {
                document.getElementById('clinicalData').checked = true;
            }
            if (subjectLower.includes('textual') || subjectLower.includes('text')) {
                document.getElementById('textualData').checked = true;
            }
            if (subjectLower.includes('machine')) {
                document.getElementById('machineReadableText').checked = true;
            }
        });
    }

    if (data.files && Array.isArray(data.files)) {
        const fileInfoText = data.files.map(file => {
            let fileInfo = `${file.name}`;
            if (file.type) fileInfo += ` (${file.type})`;
            if (file.size !== undefined && file.size !== null && file.size !== '') {
                fileInfo += ` - ${formatSizeKB(file.size)}`;
            }
            if (file.deposit_date) fileInfo += ` - Upload Date: ${file.deposit_date}`;
            if (file.md5) fileInfo += ` - MD5: ${file.md5}`;
            return fileInfo;
        }).join('\n');

        if (fileInfoText) {
            document.getElementById('fileinformation').value = fileInfoText;
        }
    }
    markDataverseImportReady();
    invokeUrgeSidebarTextareaRefresh();
}

/**
 * Apply normalized repo metadata (Dataverse parse or Figshare API) to the main form.
 * Mirrors the successful path of #fetchApiButton after parseDataverseMetadata.
 */
function applyParsedRepoMetadataToForm(data) {
    if (!data || typeof data !== 'object') {
        return;
    }
    cachedDataverseApiResponse = data;
    if (data.title) {
        $('#title').val(data.title);
    }
    if (data.doi) {
        $('#doi').val(data.doi);
    } else if (data.persistentUrl) {
        $('#doi').val(data.persistentUrl);
    }
    if (data.author) {
        $('#name').val(data.author);
    }
    if (data.institution) {
        $('#institution').val(data.institution);
    }
    if (data.email) {
        $('#email').val(data.email);
    }
    if (data.orcid) {
        $('#orcid').val(data.orcid);
    }
    if (data.description) {
        $('#description').val(data.description);
    }
    dataverseMetadata.contributors = data.contributors || '';
    dataverseMetadata.dataType = data.dataType || '';
    dataverseMetadata.dateCollection = data.dateCollection || '';
    dataverseMetadata.geoLocation = data.geoLocation || '';
    dataverseMetadata.funding = data.funding || '';

    let sharingText = '';
    if (data.license) {
        sharingText += `Licenses/Restrictions: ${data.license}\n\n`;
    }
    if (data.relatedPublication) {
        sharingText += 'Links to publications that cite or use the data:\n';
        const pubs = data.relatedPublication.split(';').map(function (p) { return p.trim(); });
        pubs.forEach(function (pub) {
            sharingText += `- ${pub}\n`;
        });
        sharingText += '\n';
    }
    if (data.relatedDataset) {
        sharingText += 'Links/relationships to related data sets:\n';
        const datasets = data.relatedDataset.split(';').map(function (d) { return d.trim(); });
        datasets.forEach(function (dataset) {
            sharingText += `- ${dataset}\n`;
        });
        sharingText += '\n';
    }
    if (data.dataSources) {
        sharingText += 'Data sources:\n';
        const sources = data.dataSources.split(';').map(function (s) { return s.trim(); });
        sources.forEach(function (source) {
            sharingText += `- ${source}\n`;
        });
    }
    $('#sharing').val(sharingText);

    if (data.files && Array.isArray(data.files)) {
        const fileInfoText = data.files.map(function (file) {
            let fileInfo = `${file.name || ''}`;
            if (file.type) {
                fileInfo += ` (${file.type})`;
            }
            if (file.size !== undefined && file.size !== null && file.size !== '') {
                fileInfo += ` - ${formatSizeKB(file.size)}`;
            }
            if (file.deposit_date) {
                fileInfo += ` - Upload Date: ${file.deposit_date}`;
            }
            return fileInfo;
        }).join('\n');
        if (fileInfoText) {
            $('#fileinformation').val(fileInfoText);
        }
    }

    invokeUrgeSidebarTextareaRefresh();
}

// Status messages in the UI
function showLoadingMessage() {
    const messageDiv = document.createElement('div');
    messageDiv.id = 'statusMessage';
    messageDiv.className = 'alert alert-info';
    messageDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading data...';
    insertMessageAfterElement('privaturl', messageDiv);
}

function showSuccessMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.id = 'statusMessage';
    messageDiv.className = 'alert alert-success';
    messageDiv.innerHTML = `<i class="fas fa-check-circle"></i> ${message}`;
    insertMessageAfterElement('privaturl', messageDiv);
}

function showErrorMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.id = 'statusMessage';
    messageDiv.className = 'alert alert-danger';
    messageDiv.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;
    insertMessageAfterElement('privaturl', messageDiv);
}

function insertMessageAfterElement(elementId, messageDiv) {
    const element = document.getElementById(elementId);
    const existingMessage = document.getElementById('statusMessage');
    if (existingMessage) {
        existingMessage.remove();
    }
    element.parentNode.insertBefore(messageDiv, element.nextSibling);
}

// ORCID format helper
function formatORCID(input) {
    var num = input.value.replace(/\D/g,'');
    var formattedNum = '';
    for (var i = 0; i < num.length; i++) {
        if (i > 0 && i % 4 === 0) formattedNum += '-';
        formattedNum += num[i];
    }
    input.value = formattedNum;
}

// Form validation
(function() {
    'use strict';
    window.addEventListener('load', function() {
        var forms = document.getElementsByClassName('needs-validation');
        Array.prototype.filter.call(forms, function(form) {
            form.addEventListener('submit', function(event) {
                if (form.checkValidity() === false) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                form.classList.add('was-validated');
            }, false);
        });
    }, false);
})();

// Collect form values
function gatherFormData() {
    const formData = {};
    const elements = {
        'title': 'Title',
        'name': 'Name',
        'institution': 'Institution',
        'email': 'Email',
        'description': 'Description',
        'methodology': 'Methodology',
        'methodology2': 'Methodology 2',
        'methodology3': 'Methodology 3',
        'fileinformation': 'File Information',
        'datascientific': 'Data Scientific',
        'sharing': 'Sharing',
        'startDate': 'Start Date',
        'endDate': 'End Date',
        'location': 'Location'
    };

    for (const [id, label] of Object.entries(elements)) {
        const element = document.getElementById(id);
        formData[id] = element ? element.value || '' : '';
    }

    const orcidElement = document.getElementById('orcid');
    if (orcidElement && orcidElement.value) {
        formData.orcid = orcidElement.value;
    }

    formData.dataType = [];
    const dataTypes = ['survyData', 'observationData', 'experimentalData', 'clinicalData', 'textualData', 'machineReadableText'];
    dataTypes.forEach(type => {
        const element = document.getElementById(type);
        if (element && element.checked) {
            formData.dataType.push(element.value || type);
        }
    });

    const otherType = document.getElementById('otherType');
    if (otherType) {
        formData.otherType = otherType.value;
    }

    const checkboxes = {
        'contributorsCheck': 'contributors',
        'dataTypeCheck': 'dataType',
        'dateCollectionCheck': 'dateCollection',
        'geoLocationCheck': 'geoLocation',
        'fundingCheck': 'funding'
    };

    Object.entries(checkboxes).forEach(([checkboxId, field]) => {
        const checkbox = document.getElementById(checkboxId);
        if (checkbox && checkbox.checked && dataverseMetadata[field]) {
            formData[field] = dataverseMetadata[field];
        }
    });

    return formData;
}

// Record README button clicks for the updates-page chart
function recordButtonClick(buttonId) {
    fetch('/api/record_button_click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ button_id: buttonId })
    }).catch(function() {});
}

// Generate README file
function generateReadMe() {
    recordButtonClick('generate_readme');
    var form = document.getElementById('readmeForm');
    if (!form) {
        console.error('Form not found');
        return;
    }

    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
    }

    try {
        const formData = gatherFormData();
        let readmeText = generateReadMeText(formData, false);
        download("ReadMe.txt", readmeText);
        clearApiCache();
    } catch (error) {
        console.error('An error occurred while creating the README file. Please ensure that all required fields are filled out.');
        alert('An error occurred while creating the README file. Please ensure that all required fields are filled out.');
    }
}

// Show README text in a modal preview (no file download)
function openReadMePreview() {
    var form = document.getElementById('readmeForm');
    if (!form) {
        console.error('Form not found');
        return;
    }

    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
    }

    try {
        const formData = gatherFormData();
        const readmeText = generateReadMeText(formData, false);
        const contentEl = document.getElementById('readmePreviewContent');
        if (contentEl) {
            contentEl.textContent = readmeText;
        }
        const modalEl = document.getElementById('readmePreviewModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
            modal.show();
        } else {
            alert(readmeText);
        }
    } catch (error) {
        console.error('An error occurred while preparing README preview:', error);
        alert('An error occurred while preparing the README preview. Please ensure that all required fields are filled out.');
    }
}

// Anonymous README: show the warning modal first
function generateAnonymousReadMe() {
    recordButtonClick('anonymous_readme');
    var form = document.getElementById('readmeForm');
    if (!form) {
        console.error('Form not found');
        return;
    }

    // Personal fields are optional for the anonymous README
    const personalFields = ['name', 'institution', 'email', 'orcid'];
    personalFields.forEach(field => {
        const element = document.getElementById(field);
        if (element) {
            element.required = false;
        }
    });

    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        personalFields.forEach(field => {
            const element = document.getElementById(field);
            if (element) element.required = true;
        });
        return;
    }

    const modalEl = document.getElementById('anonymousReadmeModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.show();
    } else {
        confirmAnonymousReadMe();
    }
}

// On OK: close the modal, then generate and download the anonymous README
function confirmAnonymousReadMe() {
    const modalEl = document.getElementById('anonymousReadmeModal');
    if (modalEl && typeof bootstrap !== 'undefined') {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        modal.hide();
    }

    var form = document.getElementById('readmeForm');
    if (!form) return;

    const personalFields = ['name', 'institution', 'email', 'orcid'];
    personalFields.forEach(field => {
        const element = document.getElementById(field);
        if (element) element.required = false;
    });

    try {
        const formData = gatherFormData();
        let readmeText = generateReadMeText(formData, true);
        download("ReadMe_Anonymous.txt", readmeText);
        clearApiCache();
    } catch (error) {
        console.error('Error creating anonymous README:', error);
        alert('An error occurred while creating the anonymous README file. Please make sure all required fields are filled.');
    } finally {
        personalFields.forEach(field => {
            const element = document.getElementById(field);
            if (element) element.required = true;
        });
    }
}

// Build README body (DataverseNO header, USN CITE/SHARING line, and Acknowledgements removed)
function generateReadMeText(formData, isAnonymous) {
    if (!formData.doi) {
        formData.doi = document.getElementById('doi') ? document.getElementById('doi').value : '';
    }
    let readmeText = `This README file was generated on ${new Date().toISOString().slice(0, 10)}`;
    if (!isAnonymous) {
        readmeText += ` by ${formData.name}\n`;
    }
    readmeText += `Last updated: ${new Date().toISOString().slice(0, 10)}`;

    readmeText += `\n\n-------------------\nGENERAL INFORMATION\n-------------------\n`;
    readmeText += `Title of Dataset: ${formData.title}\n`;
    readmeText += `DOI: ${formData.doi}\n`;

    if (!isAnonymous) {
        readmeText += `\nContact Information:\n`;
        readmeText += `  Name: ${formData.name}\n`;
        readmeText += `  Institution: ${formData.institution}\n`;
        readmeText += `  Email: ${formData.email}\n`;
        readmeText += `  ORCID: ${formData.orcid}\n`;
    }
    // Checked fields: write the value, or the placeholder if empty
    var dataverseReadmePlaceholders = {
        contributors: 'Contributors: See metadata field Contributor.',
        dataType: 'Data Type: See metadata field Data Type.',
        dateCollection: 'Date of Collection: See metadata field Date of Collection.',
        geoLocation: 'Geographic location: See metadata section Geospatial Metadata.',
        funding: 'Funding sources: See metadata section Funding Information.'
    };
    var dataverseReadmeLabels = {
        contributors: 'Contributors',
        dataType: 'Data Type',
        dateCollection: 'Date of Collection',
        geoLocation: 'Geographic Location',
        funding: 'Funding Sources'
    };
    function hasValue(val) {
        if (val == null) return false;
        if (Array.isArray(val)) {
            var trimmed = val.map(function(x) { return String(x).trim(); }).join('');
            return trimmed.length > 0;
        }
        if (typeof val === 'string') return val.trim() !== '';
        return true;
    }
    function formatValue(val) {
        if (Array.isArray(val)) {
            var parts = val.map(function(x) { return String(x).trim(); }).filter(Boolean);
            return parts.length ? parts.join(', ') : '';
        }
        return String(val);
    }
    let dataverseInfo = '';
    ['contributors', 'dataType', 'dateCollection', 'geoLocation', 'funding'].forEach(function(field) {
        var checkEl = document.getElementById(field + 'Check');
        if (!checkEl || !checkEl.checked) return;
        var value = formData[field];
        if (hasValue(value)) {
            var label = dataverseReadmeLabels[field];
            dataverseInfo += (label ? label + ': ' : '') + formatValue(value) + '\n';
        } else {
            dataverseInfo += (dataverseReadmePlaceholders[field] || '') + '\n';
        }
    });
    if (dataverseInfo) {
        readmeText += `\n${dataverseInfo}`;
    }
    let dataTypeText = '';
    if (Array.isArray(formData.dataType)) {
        dataTypeText = formData.dataType.join(', ');
    } else if (typeof formData.dataType === 'string') {
        dataTypeText = formData.dataType;
    }
    if (formData.otherType) {
        dataTypeText += dataTypeText ? `, ${formData.otherType}` : formData.otherType;
    }
    readmeText += `\nDescription of dataset: \n${formData.description}\n`;
    readmeText += `\n--------------------------\nMETHODOLOGICAL INFORMATION\n--------------------------`;
    readmeText += `\nDescription of sources and methods used for collection/generation of data:\n`;
    readmeText += `${formData.methodology}\n`;
    readmeText += `\nMethods for processing the data:\n`;
    readmeText += `${formData.methodology2}\n`;
    readmeText += `\n`;
    readmeText += `${formData.methodology3}\n`;
    readmeText += `\n--------------------\nDATA & FILE OVERVIEW\n--------------------\n`;
    readmeText += `\nFile List:\n`;
    readmeText += `${formData.fileinformation}\n`;
    readmeText += `\n-----------------------------------------\nDATA-SPECIFIC INFORMATION FOR: [FILENAME]\n-----------------------------------------\n`;
    readmeText += `${formData.datascientific}\n`;
    readmeText += `\n------------------\nSHARING/ACCESS INFORMATION\n------------------\n`;
    readmeText += `${formData.sharing}\n`;
    return readmeText;
}

// Trigger a file download
function download(filename, text) {
    const element = document.createElement('a');
    element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));
    element.setAttribute('download', filename);
    element.style.display = 'none';
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
}

// Clear server-side session metadata after the user downloads a file
function clearApiCache() {
    fetch('/api/clear_session_metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(function() {});
}

// Persist README on the server (legacy helper)
$("#saveServerReadMe").click(function() {
    const formData = gatherFormData();
    const projectTitle = formData.title;
    const name = formData.name;

    $.post("/readme/save_readme", {readmeContent: JSON.stringify(formData), projectTitle, name})
        .done(function(data) {
            $('#fileLink').attr('href', data.file_path);
            $('#fileLink').text(data.file_path);

            $('#copyButton').click(function() {
                navigator.clipboard.writeText(data.file_path).then(function() {
                    alert('Link copied to clipboard.');
                }).catch(function() {
                    alert('Copying to clipboard failed.');
                });
            });

            $('#fileLocationModal').modal('show');
        })
        .fail(function() {
            alert("An error occurred.");
        });
});

// Popovers and related UI
$(document).ready(function(){
    let insidePopover = false;

    $('body').on('mouseenter', '.popover', function() {
        insidePopover = true;
    }).on('mouseleave', '.popover', function() {
        insidePopover = false;
    });

    $('#datascientific').on('blur', function() {
        if (!insidePopover) {
            const relatedButtonId = 'datascientificButton';
            popoverList.find(pop => pop._element.id === relatedButtonId).hide();
        }
    });

    $('#datascientificButton').on('shown.bs.popover', function() {
        $('.popover').css('max-width', '500px');
    });

    var popoverContents = {
        'infoButton': 'If your data require different citation methods than the traditional citation methods, please specify.',
        'methodologyInfoButton': '<p>Include links or references to sources, publications, reports or other documentation (e.g. survey questionnaires, interview protocols, Preregistrations or Registered Reports) containing (experimental) study design or protocols, or other collection techniques used, as well as personnel involved in data collection/generation.</p>',
        'methodologyInfoButton2': '<p><strong>If data other than raw data are provided, describe how the submitted data were processed from the raw or collected/generated data.</strong><br />The documentation of methods used for data processing should include (if applicable): details that may influence reuse or replication efforts; data cleaning and analysis syntax; code or algorithms, with commenting to explain steps taken, to reproduce all reported findings; de-identification procedures for sensitive human subjects or endangered species data.<br />If applicable, code, algorithm or command files used to create derived data should be included in the dataset and referred to in this section.</p>',
        'methodologyInfoButton3': 'If not covered above, include full name and version of software, and any necessary packages or libraries needed to read and interpret the data, e.g. to run scripts. For experimental data, specify and describe the facilities and instruments used in the experiment(s).',
        'fileListInfoButton': '<p>File List:</p><ul><li>List all files contained in the dataset. For each file, provide:</li><li>a brief description of what data it contains,</li><li>date for the file creation, and date for updates</li><li>the file format (e.g. plain text) if not obvious from file extension (e.g. .txt),</li><li>if necessary, include system and hardware requirements needed to open and read the file,<br /><br /><strong>Relationship between files, if important:&nbsp;</strong><br />Is this a new version of a previously published dataset? yes/no<br />If yes, repeat the following information for each file that was updated. If not, remove the three lines below.</li></ul><p><strong>&nbsp; &nbsp; &nbsp;File name:&nbsp;</strong><br />&nbsp; &nbsp; &nbsp;Why was the file updated?:&nbsp;<br />&nbsp; &nbsp; &nbsp;When was the file updated (YYYY-MM-DD)?:&nbsp;<br /><br />FileMap.zip is a program that can be used to index folders in the Windows environment. You can <a download="" href="static/tools/FileMap.zip">download</a> this program from here, move it to the folder you want to index and run it.</p>'
    };

    var popoverTriggerList = [].slice.call(document.querySelectorAll('#infoButton, #methodologyInfoButton, #methodologyInfoButton2, #methodologyInfoButton3, #fileListInfoButton, #datascientificButton'));
    var popoverList = popoverTriggerList.map(function (popoverTriggerEl) {
        let contentSource = popoverContents[popoverTriggerEl.id];
        if (popoverTriggerEl.id === 'datascientificButton') {
            contentSource = document.getElementById("datascientificContent").innerHTML;
        }
        return new bootstrap.Popover(popoverTriggerEl, {
            title: 'Information',
            content: contentSource,
            trigger: 'manual',
            html: true
        });
    });

    $('#infoButton, #methodologyInfoButton, #methodologyInfoButton2, #methodologyInfoButton3, #fileListInfoButton, #datascientificButton').on('click', function() {
        popoverList.find(pop => pop._element.id === this.id).toggle();
    });

    let blurTimer;

    $('#sharing, #methodology, #methodology2, #methodology3, #fileinformation, #datascientific').on('focus', function() {
        const relatedButtonId = this.id === 'sharing' ? 'infoButton' :
                            this.id === 'methodology' ? 'methodologyInfoButton' :
                            this.id === 'methodology2' ? 'methodologyInfoButton2' :
                            this.id === 'methodology3' ? 'methodologyInfoButton3' :
                            this.id === 'datascientific' ? 'datascientificButton' :
                            'fileListInfoButton';

        popoverList.find(pop => pop._element.id === relatedButtonId).show();
    }).on('blur', function() {
        blurTimer = setTimeout(() => {
            const relatedButtonId = this.id === 'sharing' ? 'infoButton' :
                                this.id === 'methodology' ? 'methodologyInfoButton' :
                                this.id === 'methodology2' ? 'methodologyInfoButton2' :
                                this.id === 'methodology3' ? 'methodologyInfoButton3' :
                                this.id === 'datascientific' ? 'datascientificButton' :
                                'fileListInfoButton';

            popoverList.find(pop => pop._element.id === relatedButtonId).hide();
        }, 100);
    });

    $('body').on('click', '#addColumnVariable, #addColumnMissing, #addColumnSpecialized, #addColumnData, #addColumnContextual', function(e) {
        e.preventDefault();
        clearTimeout(blurTimer);
        const currentText = $('#datascientific').val();
        const textToInsert = $(this).text() + ': ';
        $('#datascientific').val(currentText + "\n" + textToInsert);
        invokeUrgeSidebarTextareaRefresh();
    });

    $(".insertable").on('click', function(e){
        e.preventDefault();
        const textToInsert = $(this).text();
        const currentText = $("#methodology3").val();
        $("#methodology3").val(currentText + "\n" + textToInsert + " : ");
        invokeUrgeSidebarTextareaRefresh();
    });

    $(".insertableFile").on('click', function (e) {
        e.preventDefault();
    
        const textToInsert = $(this).text();
        const currentText = $("#fileinformation").val();
    
        // Append extra text for a few known labels
        if (textToInsert === "Is this an updated version of a dataset published on DataverseNO? yes/no") {
            const additionalText = `
    Version number of dataset:     
    File name: 
    Why was the file updated? 
    When was the file updated (YYYY-MM-DD)?: 
    What was changed? 
            `;
            $("#fileinformation").val(currentText + "\n" + textToInsert + " : " + additionalText);
        } else {
            $("#fileinformation").val(currentText + "\n" + textToInsert + " : ");
        }
        invokeUrgeSidebarTextareaRefresh();
    });
    


    $('[data-bs-toggle="tooltip"]').tooltip();

    const checkboxes = {
        'contributorsCheck': {field: 'contributors', label: 'contributorsLabel'},
        'dataTypeCheck': {field: 'dataType', label: 'dataTypeLabel'},
        'dateCollectionCheck': {field: 'dateCollection', label: 'dateCollectionLabel'},
        'geoLocationCheck': {field: 'geoLocation', label: 'geoLocationLabel'},
        'fundingCheck': {field: 'funding', label: 'fundingLabel'}
    };

    // Keep the checkbox checked and show a placeholder when no value is available
    var placeholders = {
        contributors: 'See metadata field Contributor.',
        dataType: 'See metadata field Data Type.',
        dateCollection: 'See metadata field Date of Collection.',
        geoLocation: 'See metadata section Geospatial Metadata.',
        funding: 'See metadata section Funding Information.'
    };
    Object.entries(checkboxes).forEach(([checkboxId, config]) => {
        $(`#${checkboxId}`).change(function() {
            const isChecked = $(this).is(':checked');
            const label = $(`#${config.label}`);
            
            if (isChecked) {
                const value = dataverseMetadata && dataverseMetadata[config.field];
                if (value) {
                    label.text(value);
                    label.removeClass('text-muted').addClass('text-dark');
                    const formField = document.getElementById(config.field);
                    if (formField) formField.value = value;
                    const metaResult = document.getElementById(`${config.field}_meta_result`);
                    const metaContainer = document.getElementById(`${config.field}_meta_container`);
                    if (metaResult) metaResult.textContent = value;
                    if (metaContainer) metaContainer.classList.remove('hidden');
                } else {
                    label.text(placeholders[config.field] || 'Check to retrieve from Dataverse');
                    label.removeClass('text-dark').addClass('text-muted');
                }
            } else {
                label.text('Check to retrieve from Dataverse');
                label.removeClass('text-dark').addClass('text-muted');
                const formField = document.getElementById(config.field);
                if (formField) formField.value = '';
                const metaContainer = document.getElementById(`${config.field}_meta_container`);
                if (metaContainer) metaContainer.classList.add('hidden');
            }
        });
    });

});

// JSON import helpers
let jsonData = null;
/** 'sikt' | 'dsw' — which DMP import tab opened the dataset modal (for Only Methodology checkbox). */
let dmpImportKind = 'sikt';
/** Set when DSW Questionnaire Report flow opens the modal. */
let dswImportContext = null;

// DSW fallback constants when KM title/section mapping fails
const DSW_FALLBACK_DATASET_LIST_PREFIX = 'd5b27482-b598-4b8c-b534-417d4ad27394.4e0c1edf-660c-4ebf-81f5-9fa959dead30';
const DSW_FALLBACK_Q_DESCRIPTION = '205a886d-83d7-4359-ae63-7103e05357c3';
const DSW_FALLBACK_Q_DATA_TYPE = '3a8ed3fc-b1a6-4119-80ed-238804861734';
const DSW_FALLBACK_Q_IDENTIFIERS_LIST = 'cf727a0a-78c4-45a7-aa9b-cf7650ae873a';
const DSW_FALLBACK_DATASET_TITLE_UUIDS = [
    'b0949d09-d179-4491-9fb4-14b0deb9f862',
    'a077aec4-83d2-45c2-8d9f-75a391bdee20',
    'd87a239f-9aee-4d6a-a5f6-fa83c73e67e1'
];

const DSW_PRODUCING_LIST_TITLE = 'Specify a list of data sets you will be producing';
const DSW_CONTRIBUTORS_LIST_TITLE = 'Contributors';

function dswKmQuestions(km) {
    return (km && km.entities && km.entities.questions) || {};
}

function dswKmChapters(km) {
    return (km && km.entities && km.entities.chapters) || {};
}

function dswFindListQuestionUuidByTitle(km, exactTitle) {
    const qs = dswKmQuestions(km);
    for (const uuid in qs) {
        const q = qs[uuid];
        if (q && q.questionType === 'ListQuestion' && q.title === exactTitle) return uuid;
    }
    return null;
}

function dswFindChapterUuidForQuestion(km, questionUuid) {
    const chapters = dswKmChapters(km);
    for (const chUuid in chapters) {
        const ch = chapters[chUuid];
        if (ch && Array.isArray(ch.questionUuids) && ch.questionUuids.indexOf(questionUuid) !== -1) return chUuid;
    }
    return null;
}

function dswResolveListReplyPrefix(replies, km, listTitleExact) {
    const qUuid = dswFindListQuestionUuidByTitle(km, listTitleExact);
    if (!qUuid) return null;
    const ch = dswFindChapterUuidForQuestion(km, qUuid);
    if (!ch) return null;
    const path = ch + '.' + qUuid;
    const entry = replies[path];
    if (entry && entry.value && entry.value.type === 'ItemListReply') return path;
    return null;
}

function dswBuildProducingFieldIds(km, listQUuid) {
    const qs = dswKmQuestions(km);
    const listQ = qs[listQUuid];
    const template = (listQ && listQ.itemTemplateQuestionUuids) || [];
    const out = { datasetNameUuids: [], descriptionUuids: [], dataTypeUuids: [], identifiersListUuids: [] };
    for (let i = 0; i < template.length; i++) {
        const quid = template[i];
        const q = qs[quid];
        if (!q || !q.title) continue;
        const t = q.title.trim().toLowerCase();
        if (q.questionType === 'ValueQuestion' && (t === 'data set:' || t === 'data set' || /^data set\s*:?$/.test(t))) {
            out.datasetNameUuids.push(quid);
        }
        if (t.indexOf('description of the data set') !== -1) out.descriptionUuids.push(quid);
        if (t.indexOf('what type of data is in this data set') !== -1) out.dataTypeUuids.push(quid);
        if (t.indexOf('identifier of the data set') !== -1 && q.questionType === 'ListQuestion') {
            out.identifiersListUuids.push(quid);
        }
    }
    return out;
}

function dswEnsureProducingFieldIds(km, listQUuid) {
    const ids = listQUuid ? dswBuildProducingFieldIds(km, listQUuid) : {
        datasetNameUuids: [],
        descriptionUuids: [],
        dataTypeUuids: [],
        identifiersListUuids: []
    };
    if (!ids.datasetNameUuids.length) ids.datasetNameUuids = DSW_FALLBACK_DATASET_TITLE_UUIDS.slice();
    if (!ids.descriptionUuids.length) ids.descriptionUuids = [DSW_FALLBACK_Q_DESCRIPTION];
    if (!ids.dataTypeUuids.length) ids.dataTypeUuids = [DSW_FALLBACK_Q_DATA_TYPE];
    if (!ids.identifiersListUuids.length) ids.identifiersListUuids = [DSW_FALLBACK_Q_IDENTIFIERS_LIST];
    return ids;
}

function dswBuildContributorFieldIds(km, listQUuid) {
    const qs = dswKmQuestions(km);
    const template = (qs[listQUuid] && qs[listQUuid].itemTemplateQuestionUuids) || [];
    const out = { name: [], email: [], orcid: [], affiliation: [], role: [] };
    for (let i = 0; i < template.length; i++) {
        const quid = template[i];
        const q = qs[quid];
        if (!q || !q.title) continue;
        const t = q.title.trim().toLowerCase();
        if (t === 'name') out.name.push(quid);
        else if (t.indexOf('e-mail') !== -1 || t === 'email' || t === 'email address') out.email.push(quid);
        else if (t.indexOf('orcid') !== -1) out.orcid.push(quid);
        else if (t === 'affiliation') out.affiliation.push(quid);
        else if (t === 'role') out.role.push(quid);
    }
    return out;
}

function dswCollectAnswerUuidsForLabel(km, labelInsensitive) {
    const answers = (km && km.entities && km.entities.answers) || {};
    const want = String(labelInsensitive).trim().toLowerCase();
    const ids = [];
    for (const id in answers) {
        const lab = answers[id] && answers[id].label;
        if (lab && String(lab).trim().toLowerCase() === want) ids.push(id);
    }
    return ids;
}

function dswFirstScalarFromMany(replies, itemPrefix, questionUuids, km) {
    if (!questionUuids || !questionUuids.length) return '';
    for (let i = 0; i < questionUuids.length; i++) {
        const s = dswFindScalarUnderItem(replies, itemPrefix, questionUuids[i], km);
        if (s) return s;
    }
    return '';
}

function dswCollectIdentifierStringsForLists(replies, itemPrefix, listQuestionUuids) {
    const lists = (listQuestionUuids && listQuestionUuids.length)
        ? listQuestionUuids
        : [DSW_FALLBACK_Q_IDENTIFIERS_LIST];
    for (let u = 0; u < lists.length; u++) {
        const suffix = '.' + lists[u];
        const listKeys = Object.keys(replies).filter(function (k) {
            return k.startsWith(itemPrefix) && k.endsWith(suffix);
        });
        listKeys.sort(function (a, b) { return a.length - b.length; });
        const out = [];
        for (let li = 0; li < listKeys.length; li++) {
            const listKey = listKeys[li];
            const listEntry = replies[listKey];
            if (!listEntry || !listEntry.value || listEntry.value.type !== 'ItemListReply') continue;
            const itemIds = listEntry.value.value || [];
            for (let i = 0; i < itemIds.length; i++) {
                const subPrefix = listKey + '.' + itemIds[i] + '.';
                const allKeys = Object.keys(replies);
                for (let k = 0; k < allKeys.length; k++) {
                    const key = allKeys[k];
                    if (!key.startsWith(subPrefix)) continue;
                    const val = replies[key] && replies[key].value;
                    if (val && val.type === 'StringReply' && val.value && String(val.value).trim()) {
                        out.push(String(val.value).trim());
                    }
                }
            }
        }
        if (out.length) return out;
    }
    return [];
}

function dswGetAffiliationDisplayUnderItem(replies, itemPrefix, affUuids, km) {
    if (!affUuids || !affUuids.length) return '';
    for (let a = 0; a < affUuids.length; a++) {
        const suffix = '.' + affUuids[a];
        const keys = Object.keys(replies).filter(function (k) {
            return k.startsWith(itemPrefix) && k.endsWith(suffix);
        });
        keys.sort(function (a, b) { return a.length - b.length; });
        for (let i = 0; i < keys.length; i++) {
            const v = replies[keys[i]] && replies[keys[i]].value;
            if (!v || v.type !== 'IntegrationReply' || !v.value) continue;
            const display = v.value.value != null ? String(v.value.value).trim() : '';
            const raw = v.value.raw || {};
            let idPart = '';
            const r0 = raw.id || raw.ror || raw.rorUrl || raw.url;
            if (typeof r0 === 'string' && r0.length) {
                if (r0.indexOf('ror.org') !== -1 || r0.indexOf('doi.org') !== -1) idPart = ' (' + r0 + ')';
            } else if (raw.ror_id) {
                const rid = String(raw.ror_id).replace(/^https?:\/\/ror\.org\//i, '');
                idPart = ' (https://ror.org/' + rid + ')';
            }
            if (display || idPart) return (display + idPart).trim();
        }
    }
    return dswFirstScalarFromMany(replies, itemPrefix, affUuids, km);
}

function dswItemHasContactPersonRole(replies, itemPrefix, roleUuids, contactAnswerIds) {
    if (!contactAnswerIds.length || !roleUuids.length) return false;
    const set = {};
    for (let i = 0; i < contactAnswerIds.length; i++) set[contactAnswerIds[i]] = true;
    for (let r = 0; r < roleUuids.length; r++) {
        const suffix = '.' + roleUuids[r];
        const keys = Object.keys(replies).filter(function (k) {
            return k.startsWith(itemPrefix) && k.endsWith(suffix);
        });
        for (let i = 0; i < keys.length; i++) {
            const v = replies[keys[i]] && replies[keys[i]].value;
            if (!v) continue;
            if (v.type === 'MultiChoiceReply' && Array.isArray(v.value)) {
                for (let j = 0; j < v.value.length; j++) {
                    if (set[v.value[j]]) return true;
                }
            }
            if (v.type === 'AnswerReply' && set[v.value]) return true;
        }
    }
    return false;
}

function dswFindContactPersonItemPrefix(replies, contribListPrefix, contribItemUuids, contribFieldIds, contactAnswerIds) {
    if (!contribListPrefix || !contribItemUuids || !contribFieldIds) return null;
    for (let i = 0; i < contribItemUuids.length; i++) {
        const p = contribListPrefix + '.' + contribItemUuids[i] + '.';
        if (dswItemHasContactPersonRole(replies, p, contribFieldIds.role, contactAnswerIds)) return p;
    }
    return null;
}

function dswApplyContactPersonToForm(ctx) {
    if (!ctx.contributorsListPrefix || !ctx.contribFieldIds) return false;
    const listEntry = ctx.replies[ctx.contributorsListPrefix];
    if (!listEntry || !listEntry.value || listEntry.value.type !== 'ItemListReply') return false;
    const cItems = listEntry.value.value || [];
    const contactAns = dswCollectAnswerUuidsForLabel(ctx.km, 'Contact Person');
    const itemPx = dswFindContactPersonItemPrefix(
        ctx.replies,
        ctx.contributorsListPrefix,
        cItems,
        ctx.contribFieldIds,
        contactAns
    );
    if (!itemPx) return false;
    const ids = ctx.contribFieldIds;
    const name = dswFirstScalarFromMany(ctx.replies, itemPx, ids.name, ctx.km);
    const email = dswFirstScalarFromMany(ctx.replies, itemPx, ids.email, ctx.km);
    const orcidRaw = dswFirstScalarFromMany(ctx.replies, itemPx, ids.orcid, ctx.km);
    const inst = dswGetAffiliationDisplayUnderItem(ctx.replies, itemPx, ids.affiliation, ctx.km);
    const nameElement = document.getElementById('name');
    const emailElement = document.getElementById('email');
    const orcidElement = document.getElementById('orcid');
    const instElement = document.getElementById('institution');
    if (nameElement && name) nameElement.value = name;
    if (emailElement && email) emailElement.value = email;
    if (orcidElement && orcidRaw) orcidElement.value = orcidRaw;
    if (instElement && inst) instElement.value = inst;
    return true;
}

function escapeHtmlForModal(s) {
    if (s == null || s === '') return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function dswGetReplyScalar(replies, path, km) {
    const entry = replies[path];
    if (!entry || !entry.value) return '';
    const v = entry.value;
    const answers = km && km.entities && km.entities.answers;
    if (v.type === 'StringReply') return (v.value != null ? String(v.value) : '').trim();
    if (v.type === 'AnswerReply' && answers && answers[v.value]) {
        const label = answers[v.value].label;
        return label != null ? String(label).trim() : '';
    }
    if (v.type === 'MultiChoiceReply' && Array.isArray(v.value) && answers) {
        const labels = v.value.map(function (uid) { return answers[uid] && answers[uid].label; }).filter(Boolean);
        return labels.join(', ');
    }
    if (v.type === 'IntegrationReply' && v.value && v.value.value !== undefined && v.value.value !== null) {
        return String(v.value.value).trim();
    }
    return '';
}

/**
 * DSW answer paths are usually longer than listItem.questionUuid because of intermediate Options.
 * itemPrefix = listPrefix + itemUuid + '.'
 */
function dswFindScalarUnderItem(replies, itemPrefix, questionUuid, km) {
    const suffix = '.' + questionUuid;
    const keys = Object.keys(replies).filter(function (k) {
        return k.startsWith(itemPrefix) && k.endsWith(suffix);
    });
    keys.sort(function (a, b) { return a.length - b.length; });
    for (let i = 0; i < keys.length; i++) {
        const s = dswGetReplyScalar(replies, keys[i], km);
        if (s) return s;
    }
    return '';
}

function dswPickBestIdentifier(strings) {
    if (!strings || !strings.length) return '';
    const doiish = strings.find(function (s) {
        return /doi\.org/i.test(s) || /^10\.\d{4,}\//i.test(s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''));
    });
    if (doiish) return doiish;
    const url = strings.find(function (s) { return /^https?:\/\//i.test(s); });
    if (url) return url;
    return strings[0];
}

function fillModalWithDswTitles(titles) {
    let modalContent = '';
    titles.forEach(function (title, index) {
        const safe = escapeHtmlForModal(title);
        modalContent += '<div class="mb-2">Dataset ' + (index + 1) + ': ' + safe +
            ' <button type="button" class="btn btn-sm btn-primary ms-2" onclick="selectDataset(' + index + ')">Select</button></div>';
    });
    const body = document.getElementById('modalBody');
    if (body) body.innerHTML = modalContent;
}

function processDswJsonText(text) {
    try {
        const dsw = JSON.parse(text);
        dmpImportKind = 'dsw';
        dswImportContext = null;
        selectedDswDatasetIndex = null;
        jsonData = dsw;
        const qs = dsw.questionnaire;
        const km = dsw.knowledgeModel;
        if (!qs || !qs.replies || !km || !km.entities) {
            alert('Invalid DSW export: expected questionnaire.replies and knowledgeModel.');
            return;
        }
        let listPrefix = dswResolveListReplyPrefix(qs.replies, km, DSW_PRODUCING_LIST_TITLE);
        if (!listPrefix) listPrefix = DSW_FALLBACK_DATASET_LIST_PREFIX;
        const listEntry = qs.replies[listPrefix];
        if (!listEntry || !listEntry.value || listEntry.value.type !== 'ItemListReply') {
            alert('No dataset list found in this JSON (DSW Questionnaire Report — producing datasets).');
            return;
        }
        const itemUuids = listEntry.value.value || [];
        if (!itemUuids.length) {
            alert('The dataset list is empty.');
            return;
        }
        const producingQ = dswFindListQuestionUuidByTitle(km, DSW_PRODUCING_LIST_TITLE);
        const produceFieldIds = dswEnsureProducingFieldIds(km, producingQ);
        const contributorsListPrefix = dswResolveListReplyPrefix(qs.replies, km, DSW_CONTRIBUTORS_LIST_TITLE);
        const contribQ = dswFindListQuestionUuidByTitle(km, DSW_CONTRIBUTORS_LIST_TITLE);
        const contribFieldIds = (contributorsListPrefix && contribQ)
            ? dswBuildContributorFieldIds(km, contribQ)
            : null;
        const titles = itemUuids.map(function (uuid, i) {
            const itemPrefix = listPrefix + '.' + uuid + '.';
            const v = dswFirstScalarFromMany(qs.replies, itemPrefix, produceFieldIds.datasetNameUuids, km);
            return v || ('Dataset ' + (i + 1));
        });
        dswImportContext = {
            listPrefix: listPrefix,
            itemUuids: itemUuids,
            replies: qs.replies,
            km: km,
            questionnaire: qs,
            produceFieldIds: produceFieldIds,
            contributorsListPrefix: contributorsListPrefix,
            contribFieldIds: contribFieldIds
        };
        fillModalWithDswTitles(titles);
        $('#datasetModal').modal('show');
    } catch (e) {
        alert('Error parsing JSON: ' + e.toString());
    }
}

function fillFormWithJSON() {
    const fileInput = document.getElementById('jsonInput');
    const file = fileInput.files[0];
    if (!file) {
        alert("Please select a JSON file first.");
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            jsonData = JSON.parse(event.target.result);
            dmpImportKind = 'sikt';
            dswImportContext = null;
            selectedSiktDatasetIndex = null;

            const collections = jsonData.revision.document.collections;
            fillModalWithCollections(collections);
            $('#datasetModal').modal('show');
        } catch (e) {
            alert("An error occurred while parsing the JSON file: " + e.toString());
        }
    };

    reader.onerror = function() {
        alert("An error occurred while reading the file.");
    };

    reader.readAsText(file);
}

function fillFormWithDSWJSON() {
    const fileInput = document.getElementById('jsonInputDsw');
    const file = fileInput && fileInput.files[0];
    if (!file) {
        alert('Please select a JSON file first.');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (event) {
        processDswJsonText(event.target.result);
    };
    reader.onerror = function () {
        alert('An error occurred while reading the file.');
    };
    reader.readAsText(file);
}

function fillModalWithCollections(collections) {
    let modalContent = '';
    collections.forEach((collection, index) => {
        const safe = escapeHtmlForModal(collection.title);
        modalContent += '<div class="mb-2">Dataset ' + (index + 1) + ': ' + safe +
            ' <button type="button" class="btn btn-sm btn-primary ms-2" onclick="selectDataset(' + index + ')">Select</button></div>';
    });
    document.getElementById('modalBody').innerHTML = modalContent;
}

const dataTypeMappings = {
    'survy': 'survyData',
    'survy data': 'survyData',
    'observation': 'observationData',
    'observation data': 'observationData',
    'experimental': 'experimentalData',
    'experimental data': 'experimentalData',
    'clinical': 'clinicalData',
    'clinical data': 'clinicalData',
    'textual': 'textualData',
    'textual data': 'textualData',
    'text': 'textualData',
    'machine-readable': 'machineReadableText',
    'machine-readable text': 'machineReadableText'
};

function closeDatasetModal() {
    const modal = document.getElementById('datasetModal');
    if (modal) {
        const bootstrapModal = bootstrap.Modal.getInstance(modal);
        if (bootstrapModal) bootstrapModal.hide();
    }
}

function selectDataset(index) {
    try {
        if (dmpImportKind === 'dsw') {
            selectDswDataset(index);
            return;
        }
        selectedSiktDatasetIndex = index;

        const selectedDataset = jsonData.revision.document.collections[index];
        if (!selectedDataset) {
            throw new Error('Selected dataset not found');
        }

        const onlyMetaEl = document.getElementById('onlyMetadataCheck');
        const onlyMetadata = onlyMetaEl ? onlyMetaEl.checked : false;

        if (onlyMetadata) {
            if (selectedDataset.collectionMethodDescription) {
                const methodologyEl = document.getElementById('methodology');
                if (methodologyEl) {
                    methodologyEl.value = selectedDataset.collectionMethodDescription;
                }
            }
        } else {
            const titleElement = document.getElementById('title');
            const descriptionElement = document.getElementById('description');
            const nameElement = document.getElementById('name');
            const emailElement = document.getElementById('email');
            const startDateElement = document.getElementById('startDate');
            const endDateElement = document.getElementById('endDate');

            if (titleElement) titleElement.value = selectedDataset.title || '';
            if (descriptionElement) descriptionElement.value = selectedDataset.description || '';

            const dataTypes = selectedDataset.dataTypes || [];
            for (let key in dataTypeMappings) {
                const checkboxElement = document.getElementById(dataTypeMappings[key]);
                if (checkboxElement) {
                    checkboxElement.checked = false;
                }
            }

            dataTypes.forEach(type => {
                const typeLower = type.toLowerCase();
                const checkboxId = dataTypeMappings[typeLower];
                if (checkboxId) {
                    const checkboxElement = document.getElementById(checkboxId);
                    if (checkboxElement) {
                        checkboxElement.checked = true;
                    }
                } else {
                    const otherTypeElement = document.getElementById('otherType');
                    if (otherTypeElement) {
                        const existingValue = otherTypeElement.value;
                        otherTypeElement.value = existingValue ? `${existingValue}, ${type}` : type;
                    }
                }
            });

            if (nameElement && jsonData.createdBy) nameElement.value = jsonData.createdBy.name || '';
            if (emailElement && jsonData.createdBy) emailElement.value = jsonData.createdBy.email || '';
            if (startDateElement && jsonData.revision.document) startDateElement.value = jsonData.revision.document.projectStart || '';
            if (endDateElement && jsonData.revision.document) endDateElement.value = jsonData.revision.document.projectEnd || '';
        }

        if (!onlyMetadata) {
            markDmpImportReady('sikt', normalizeSiktCompareData(selectedDataset));
        }

        invokeUrgeSidebarTextareaRefresh();
        closeDatasetModal();
    } catch (error) {
        console.error('Error in dataset selection:', error);
        alert('An error occurred while selecting the dataset: ' + error.message);
    }
}

function selectDswDataset(index) {
    if (!dswImportContext) {
        throw new Error('DSW import context is missing');
    }
    const ctx = dswImportContext;
    selectedDswDatasetIndex = index;
    const itemUuid = ctx.itemUuids[index];
    if (!itemUuid) {
        throw new Error('Selected dataset not found');
    }
    const itemPrefix = ctx.listPrefix + '.' + itemUuid + '.';
    const replies = ctx.replies;
    const km = ctx.km;
    const onlyMetaEl = document.getElementById('onlyMetadataCheckDsw');
    const onlyMetadata = onlyMetaEl ? onlyMetaEl.checked : false;

    const pids = ctx.produceFieldIds || dswEnsureProducingFieldIds(km, dswFindListQuestionUuidByTitle(km, DSW_PRODUCING_LIST_TITLE));
    const description = dswFirstScalarFromMany(replies, itemPrefix, pids.descriptionUuids, km);

    if (onlyMetadata) {
        const methodologyEl = document.getElementById('methodology');
        if (methodologyEl) methodologyEl.value = description;
    } else {
        const title = dswFirstScalarFromMany(replies, itemPrefix, pids.datasetNameUuids, km);
        const ids = dswCollectIdentifierStringsForLists(replies, itemPrefix, pids.identifiersListUuids);
        const doiVal = dswPickBestIdentifier(ids);
        const dataTypeStr = dswFirstScalarFromMany(replies, itemPrefix, pids.dataTypeUuids, km);
        const dataTypes = dataTypeStr
            ? dataTypeStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
            : [];

        const titleElement = document.getElementById('title');
        const descriptionElement = document.getElementById('description');
        const doiElement = document.getElementById('doi');
        if (titleElement) titleElement.value = title;
        if (descriptionElement) descriptionElement.value = description;
        if (doiElement) doiElement.value = doiVal;

        for (let key in dataTypeMappings) {
            const checkboxElement = document.getElementById(dataTypeMappings[key]);
            if (checkboxElement) checkboxElement.checked = false;
        }
        const otherTypeElement = document.getElementById('otherType');
        if (otherTypeElement) otherTypeElement.value = '';

        dataTypes.forEach(function (type) {
            const typeLower = type.toLowerCase();
            const checkboxId = dataTypeMappings[typeLower];
            if (checkboxId) {
                const checkboxElement = document.getElementById(checkboxId);
                if (checkboxElement) checkboxElement.checked = true;
            } else if (otherTypeElement) {
                const existingValue = otherTypeElement.value;
                otherTypeElement.value = existingValue ? existingValue + ', ' + type : type;
            }
        });

        const appliedContact = dswApplyContactPersonToForm(ctx);
        if (!appliedContact) {
            const cb = (ctx.questionnaire && ctx.questionnaire.createdBy) || {};
            const nameElement = document.getElementById('name');
            const emailElement = document.getElementById('email');
            if (nameElement) {
                const fn = cb.firstName || '';
                const ln = cb.lastName || '';
                nameElement.value = (ln && fn) ? (ln + ', ' + fn) : (fn || ln || '');
            }
            if (emailElement && cb.email) emailElement.value = cb.email;
        }

        const startDateElement = document.getElementById('startDate');
        const endDateElement = document.getElementById('endDate');
        if (startDateElement) startDateElement.value = '';
        if (endDateElement) endDateElement.value = '';
        markDmpImportReady('dsw', normalizeDswCompareData(ctx, itemPrefix));
    }

    invokeUrgeSidebarTextareaRefresh();
    closeDatasetModal();
}

// ORCID search
function searchORCID() {
    const nameInput = document.getElementById("name");
    const orcidInput = document.getElementById("orcid");

    if (!nameInput) {
        alert('Name field not found.');
        return;
    }

    const fullName = nameInput.value.trim();
    if (!fullName) {
        alert('Please enter a name (Family name, Given name) first.');
        return;
    }

    let given = '';
    let family = '';

    const commaParts = fullName.split(',');
    if (commaParts.length >= 2) {
        family = commaParts[0].trim();
        given = commaParts.slice(1).join(',').trim();
    } else {
        const spaceParts = fullName.split(/\s+/).filter(Boolean);
        if (spaceParts.length >= 2) {
            given = spaceParts.slice(0, -1).join(' ');
            family = spaceParts[spaceParts.length - 1];
        } else {
            given = fullName;
        }
    }

    const params = new URLSearchParams();
    if (given) params.append('given', given);
    if (family) params.append('family', family);

    fetch('/api/orcid_search?' + params.toString(), {
        method: 'GET'
    })
        .then(response => response.json())
        .then(data => {
            if (!data || !Array.isArray(data.results) || data.results.length === 0) {
                showOrcidSuggestions([]);
                alert('No ORCID record found for this name.');
                return;
            }
            showOrcidSuggestions(data.results, orcidInput);
        })
        .catch(error => {
            console.error('Error while searching ORCID:', error);
            alert('An error occurred while searching ORCID.');
        });
}

function showOrcidSuggestions(results, orcidInput) {
    const container = document.getElementById('orcidSuggestions');
    if (!container) {
        return;
    }

    container.innerHTML = '';

    if (!results || results.length === 0) {
        container.classList.remove('show');
        return;
    }

    const inputEl = orcidInput || document.getElementById('orcid');
    if (inputEl) {
        const width = inputEl.offsetWidth;
        if (width) {
            container.style.minWidth = width + 'px';
        }
    }

    results.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dropdown-item';

        // Format: "ORCID ID - Family name, Given name" (institution if present)
        const namePart = (item.family_names || item.given_names)
            ? [item.family_names, item.given_names].filter(Boolean).join(', ')
            : (item.name || '');
        const nameDisplay = namePart ? namePart : item.orcid;
        const institutionSuffix = item.institution ? ` – ${item.institution}` : '';
        btn.textContent = `${item.orcid} - ${nameDisplay}${institutionSuffix}`;
        btn.addEventListener('click', () => {
            if (inputEl) {
                inputEl.value = item.orcid;
            }
            hideOrcidSuggestions();
        });

        container.appendChild(btn);
    });

    container.classList.add('show');
}

function hideOrcidSuggestions() {
    const container = document.getElementById('orcidSuggestions');
    if (container) {
        container.classList.remove('show');
    }
}

document.addEventListener('click', function (event) {
    const container = document.getElementById('orcidSuggestions');
    const orcidInput = document.getElementById('orcid');
    if (!container || !orcidInput) return;

    if (!container.contains(event.target) && event.target !== orcidInput) {
        hideOrcidSuggestions();
    }
});

// Parse README text: support both legacy section titles and generated TXT format
function parseReadme(readmeContent) {
    const text = readmeContent.replace(/\r\n/g, '\n');
    const parsedData = {};

    // Title of Dataset: (same line or next line)
    const titleMatch = text.match(/\bTitle of Dataset\s*:\s*(.+?)(?=\n|$)/im);
    if (titleMatch) {
        parsedData['Title of Dataset'] = titleMatch[1].trim();
    }

    // DOI:
    const doiMatch = text.match(/\bDOI\s*:\s*(.+?)(?=\n|$)/im);
    if (doiMatch) {
        parsedData['DOI'] = doiMatch[1].trim();
    }

    // Contact Information block (Name, Institution, Email, ORCID)
    const contactStart = text.search(/\bContact Information\s*:/im);
    if (contactStart >= 0) {
        const afterContact = text.slice(contactStart);
        const contactEnd = afterContact.search(/\n\s*\n(?=\w|\*|Contributors|Data Type|Date of|Geographic|Funding|Description of dataset)/im) || afterContact.length;
        const contactBlock = afterContact.slice(0, contactEnd).split('\n').filter(function (line) {
            return /^\s*(Name|Institution|Email|ORCID)\s*:/.test(line);
        });
        parsedData['Contact Information'] = contactBlock.map(function (line) {
            return line.replace(/^\s*-\s*/, '').trim();
        });
    }

    // DATE(S) OF DATA COLLECTION (legacy format)
    const dateSectionStart = text.indexOf('DATE(S) OF DATA COLLECTION AND/OR TIME PERIOD COVERED');
    if (dateSectionStart >= 0) {
        const nextSection = text.indexOf('METHODOLOGY', dateSectionStart);
        const dateContent = text.slice(dateSectionStart, nextSection >= 0 ? nextSection : undefined);
        parsedData['DATE(S) OF DATA COLLECTION AND/OR TIME PERIOD COVERED'] = dateContent.split('\n').slice(1).filter(Boolean);
    }

    // Description of dataset: ... (until METHODOLOGICAL / METHODOLOGY)
    const descMatch = text.match(/\bDescription of dataset\s*:\s*\n([\s\S]*?)(?=\n-{5,}|\nMETHODOLOGICAL INFORMATION|\nMETHODOLOGY|$)/im);
    if (descMatch) {
        parsedData['Description of dataset'] = descMatch[1].trim();
    }

    // METHODOLOGY (legacy single block) or METHODOLOGICAL INFORMATION (subsections)
    const methodHeader = text.match(/\n-{5,}\s*\n(METHODOLOGICAL INFORMATION|METHODOLOGY)/im);
    if (methodHeader) {
        const start = text.indexOf(methodHeader[1]);
        const end = text.search(/\n(?:DATA\s*&\s*FILE OVERVIEW|FILE INFORMATION|FILE LIST|DATA-SPECIFIC)/im);
        const methodSection = (end >= 0 ? text.slice(start, end) : text.slice(start)).trim();
        // Legacy format: single METHODOLOGY block
        if (methodHeader[1].toUpperCase() === 'METHODOLOGY') {
            parsedData['METHODOLOGY'] = methodSection.split('\n').slice(1).join('\n').trim();
        } else {
            const srcMatch = methodSection.match(/Description of sources and methods[^\n]*\n([\s\S]*?)(?=Methods for processing the data:|$)/im);
            const procMatch = methodSection.match(/Methods for processing the data\s*[^\n]*\n([\s\S]*?)(?=\n\n|\n[A-Z][a-z]+.*:$|$)/im);
            if (srcMatch) parsedData['methodology'] = srcMatch[1].trim();
            if (procMatch) parsedData['methodology2'] = procMatch[1].trim();
            const afterProc = procMatch ? methodSection.indexOf(procMatch[0]) + procMatch[0].length : (srcMatch ? methodSection.indexOf(srcMatch[0]) + srcMatch[0].length : 0);
            const rest = methodSection.slice(afterProc).replace(/^\s*\n+/, '').trim();
            if (rest) parsedData['methodology3'] = rest;
        }
    }

    // Legacy METHODOLOGY (single block)
    const oldMethodIdx = text.indexOf('METHODOLOGY');
    if (oldMethodIdx >= 0 && !parsedData['methodology'] && !parsedData['METHODOLOGY']) {
        const fileIdx = text.indexOf('FILE INFORMATION', oldMethodIdx);
        const endIdx = fileIdx >= 0 ? fileIdx : text.indexOf('FILE LIST', oldMethodIdx);
        const end = endIdx >= 0 ? endIdx : text.length;
        parsedData['METHODOLOGY'] = text.slice(oldMethodIdx, end).split('\n').slice(1).join('\n').trim();
    }

    // File List or FILE INFORMATION
    const fileListMatch = text.match(/(?:File List|FILE INFORMATION)\s*:\s*\n([\s\S]*?)(?=\n-{5,}|\nDATA-SPECIFIC|\nSHARING|$)/im);
    if (fileListMatch) {
        parsedData['FILE INFORMATION'] = fileListMatch[1].trim();
    }
    const fileInfoIdx = text.indexOf('FILE INFORMATION');
    if (fileInfoIdx >= 0 && !parsedData['FILE INFORMATION']) {
        const nextIdx = text.indexOf('SHARING', fileInfoIdx);
        parsedData['FILE INFORMATION'] = text.slice(fileInfoIdx, nextIdx >= 0 ? nextIdx : undefined).split('\n').slice(1).join('\n').trim();
    }

    // DATA-SPECIFIC INFORMATION
    const dataSpecMatch = text.match(/DATA-SPECIFIC INFORMATION[^\n]*\n([\s\S]*?)(?=\n-{5,}|\nSHARING|$)/im);
    if (dataSpecMatch) {
        parsedData['DATA_SPECIFIC'] = dataSpecMatch[1].trim();
    }

    // SHARING / SHARING/ACCESS INFORMATION
    const sharingMatch = text.match(/(?:SHARING\/ACCESS INFORMATION|SHARING)\s*[:\n]*([\s\S]*?)$/im);
    if (sharingMatch) {
        parsedData['SHARING'] = sharingMatch[1].trim();
    }
    const sharingIdx = text.indexOf('SHARING');
    if (sharingIdx >= 0 && !parsedData['SHARING']) {
        parsedData['SHARING'] = text.slice(sharingIdx).split('\n').slice(1).join('\n').trim();
    }

    return parsedData;
}

// Readme Import: JSON (default) vs TXT — only one panel is visible
document.getElementById('txtImportCheck').addEventListener('change', function() {
    const jsonSection = document.getElementById('jsonImportSection');
    const txtSection = document.getElementById('txtImportSection');
    if (this.checked) {
        jsonSection.style.display = 'none';
        txtSection.style.display = 'block';
    } else {
        jsonSection.style.display = 'block';
        txtSection.style.display = 'none';
    }
});

// Fill the form from imported JSON or TXT
function fillFormWithReadme() {
    const useTxt = document.getElementById('txtImportCheck').checked;
    const fileInput = useTxt ? document.getElementById('readmeInput') : document.getElementById('jsonImportInput');
    const file = fileInput.files[0];
    
    if (!file) {
        alert("Please select a file first.");
        return;
    }

    const reader = new FileReader();
    reader.onload = function(event) {
        const content = event.target.result;
        
        if (!useTxt) {
            try {
                const jsonData = JSON.parse(content);
                fillFormWithJson(jsonData);
            } catch (error) {
                alert("An error occurred while reading the JSON file: " + error.message);
            }
        } else {
            const parsedData = parseReadme(content);
            fillFormWithReadmeData(parsedData);
        }
    };

    reader.onerror = function() {
        alert("An error occurred while reading the file.");
    };

    reader.readAsText(file);
}

// Fill the form from parsed JSON
function fillFormWithJson(jsonData) {
    try {
        if (jsonData.general_information) {
            const general = jsonData.general_information;
            
            const titleElement = document.getElementById('title');
            if (titleElement && general.title) {
                titleElement.value = general.title;
            }
            
            if (general.contact) {
                const nameElement = document.getElementById('name');
                const institutionElement = document.getElementById('institution');
                const emailElement = document.getElementById('email');
                const orcidElement = document.getElementById('orcid');
                
                if (nameElement && general.contact.name) nameElement.value = general.contact.name;
                if (institutionElement && general.contact.institution) institutionElement.value = general.contact.institution;
                if (emailElement && general.contact.email) emailElement.value = general.contact.email;
                if (orcidElement && general.contact.orcid) orcidElement.value = general.contact.orcid;
            }
            
            if (general.contributors) {
                const contributorsCheck = document.getElementById('contributorsCheck');
                const contributorsLabel = document.getElementById('contributorsLabel');
                if (contributorsCheck && contributorsLabel) {
                    contributorsCheck.checked = true;
                    contributorsLabel.textContent = general.contributors;
                    contributorsLabel.classList.remove('text-muted');
                    contributorsLabel.classList.add('text-dark');
                }
            }
            
            if (general.data_type) {
                const dataTypeCheck = document.getElementById('dataTypeCheck');
                const dataTypeLabel = document.getElementById('dataTypeLabel');
                if (dataTypeCheck && dataTypeLabel) {
                    dataTypeCheck.checked = true;
                    dataTypeLabel.textContent = general.data_type;
                    dataTypeLabel.classList.remove('text-muted');
                    dataTypeLabel.classList.add('text-dark');
                }
            }
            
            if (general.date_collection) {
                const dateCollectionCheck = document.getElementById('dateCollectionCheck');
                const dateCollectionLabel = document.getElementById('dateCollectionLabel');
                if (dateCollectionCheck && dateCollectionLabel) {
                    dateCollectionCheck.checked = true;
                    dateCollectionLabel.textContent = general.date_collection;
                    dateCollectionLabel.classList.remove('text-muted');
                    dateCollectionLabel.classList.add('text-dark');
                }
            }
            
            if (general.geo_location) {
                const geoLocationCheck = document.getElementById('geoLocationCheck');
                const geoLocationLabel = document.getElementById('geoLocationLabel');
                if (geoLocationCheck && geoLocationLabel) {
                    geoLocationCheck.checked = true;
                    geoLocationLabel.textContent = general.geo_location;
                    geoLocationLabel.classList.remove('text-muted');
                    geoLocationLabel.classList.add('text-dark');
                }
            }
            
            if (general.funding) {
                const fundingCheck = document.getElementById('fundingCheck');
                const fundingLabel = document.getElementById('fundingLabel');
                if (fundingCheck && fundingLabel) {
                    fundingCheck.checked = true;
                    fundingLabel.textContent = general.funding;
                    fundingLabel.classList.remove('text-muted');
                    fundingLabel.classList.add('text-dark');
                }
            }
        }
        
        if (jsonData.methodological_information) {
            const method = jsonData.methodological_information;
            const descriptionElement = document.getElementById('description');
            const methodologyElement = document.getElementById('methodology');
            const methodology2Element = document.getElementById('methodology2');
            const methodology3Element = document.getElementById('methodology3');
            
            if (descriptionElement && method.description) descriptionElement.value = method.description;
            if (methodologyElement && method.methodology) methodologyElement.value = method.methodology;
            if (methodology2Element && method.methodology2) methodology2Element.value = method.methodology2;
            if (methodology3Element && method.methodology3) methodology3Element.value = method.methodology3;
        }
        
        if (jsonData.file_information && jsonData.file_information.details) {
            const fileInfoElement = document.getElementById('fileinformation');
            if (fileInfoElement) {
                fileInfoElement.value = jsonData.file_information.details;
            }
        }
        
        if (jsonData.data_specific_information && jsonData.data_specific_information.data_scientific) {
            const dataScientificElement = document.getElementById('datascientific');
            if (dataScientificElement) {
                dataScientificElement.value = jsonData.data_specific_information.data_scientific;
            }
        }
        
        if (jsonData.sharing && jsonData.sharing.details) {
            const sharingElement = document.getElementById('sharing');
            if (sharingElement) {
                sharingElement.value = jsonData.sharing.details;
            }
        }
        invokeUrgeSidebarTextareaRefresh();
    } catch (error) {
        console.error('Error filling form:', error);
        alert('An error occurred while filling the form: ' + error.message);
    }
}

// Fill the form from parsed README TXT
function fillFormWithReadmeData(parsedData) {
    const set = function (id, value) {
        const el = document.getElementById(id);
        if (el && value) el.value = value;
    };

    set('title', parsedData['Title of Dataset'] || '');
    set('doi', parsedData['DOI'] || '');
    set('description', parsedData['Description of dataset'] || '');

    const contactInfoArray = parsedData['Contact Information'] || [];
    for (let i = 0; i < contactInfoArray.length; i++) {
        const item = contactInfoArray[i];
        const strippedItem = item.replace(/^-\s*/, '').trim();
        const colonIdx = strippedItem.indexOf(':');
        if (colonIdx < 0) continue;
        const key = strippedItem.slice(0, colonIdx).trim();
        const value = strippedItem.slice(colonIdx + 1).trim();
        if (key === 'Name') set('name', value);
        else if (key === 'Institution') set('institution', value);
        else if (key === 'Email') set('email', value);
        else if (key === 'ORCID') set('orcid', value);
    }

    const dateInfoArray = parsedData['DATE(S) OF DATA COLLECTION AND/OR TIME PERIOD COVERED'] || [];
    for (let j = 0; j < dateInfoArray.length; j++) {
        const match = dateInfoArray[j].match(/Start Date: (\d{4}-\d{2}-\d{2}) - Final Date: (\d{4}-\d{2}-\d{2})/);
        if (match) {
            const startEl = document.getElementById('startDate');
            const endEl = document.getElementById('endDate');
            if (startEl) startEl.value = match[1];
            if (endEl) endEl.value = match[2];
        }
    }

    set('methodology', parsedData['methodology'] || parsedData['METHODOLOGY'] || '');
    set('methodology2', parsedData['methodology2'] || '');
    set('methodology3', parsedData['methodology3'] || '');
    set('fileinformation', parsedData['FILE INFORMATION'] || '');
    set('datascientific', parsedData['DATA_SPECIFIC'] || '');
    set('sharing', parsedData['SHARING'] || '');
    invokeUrgeSidebarTextareaRefresh();
}

async function fetchDataverseDrafts() {
    const privateUrl = document.getElementById('privaturl').value;
    if (!privateUrl) {
        showErrorMessage('Private URL required');
        return;
    }

    try {
        showLoadingMessage();

        const response = await fetch('/fetch_dataverse_drafts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ private_url: privateUrl })
        });

        const data = await response.json();

        if (response.ok) {
            displayDrafts(data.drafts);
            showSuccessMessage('Dataset information loaded successfully!');
        } else {
            showErrorMessage(data.error || 'Dataset information could not be loaded');
        }
    } catch (error) {
        showErrorMessage('An error occurred: ' + error.message);
    }
}

// Cached draft list
let currentDrafts = [];
let currentFigshareDrafts = [];
let figshareSelectedDraft = null;
let currentZenodoDrafts = [];
let zenodoSelectedDraft = null;

function displayDrafts(drafts) {
    const draftsList = document.getElementById('dataverseDraftsList');
    
    if (!drafts || drafts.length === 0) {
        draftsList.innerHTML = '<div class="alert alert-info">No drafts found.</div>';
        currentDrafts = [];
        return;
    }

    currentDrafts = drafts;

    let html = '<div class="mb-3"><h6>Your Draft Datasets:</h6></div>';
    
    const draftItems = drafts.map((draft, index) => `
        <div class="card mb-2">
            <div class="card-body">
                <h6 class="card-title">${escapeHtml(draft.title || 'Untitled Dataset')}</h6>
                <p class="card-text mb-2">
                    <small class="text-muted">Last Update: ${formatDate(draft.last_update_time)}</small>
                </p>
                ${draft.doi ? `<p class="card-text mb-2"><small class="text-muted">DOI: ${escapeHtml(draft.doi)}</small></p>` : ''}
                <button class="btn btn-primary btn-sm select-draft-btn" data-draft-index="${index}">
                    Select This Draft
                </button>
            </div>
        </div>
    `).join('');

    draftsList.innerHTML = html + draftItems;
    
    draftsList.querySelectorAll('.select-draft-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const index = parseInt(this.getAttribute('data-draft-index'));
            if (currentDrafts[index]) {
                selectDraft(currentDrafts[index]);
            }
        });
    });
}

// Escape HTML
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Format a date for display
function formatDate(dateString) {
    try {
        const date = new Date(dateString);
        return date.toLocaleString('en-US');
    } catch {
        return dateString || 'Date unknown';
    }
}

function figsharePublicLinkHtml(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'https:') {
            return '';
        }
        const href = u.href.replace(/"/g, '&quot;');
        return `<p class="card-text mb-2"><small class="text-muted"><a href="${href}" target="_blank" rel="noopener noreferrer">Open on Figshare</a></small></p>`;
    } catch {
        return '';
    }
}

function displayFigshareDraftsInModal(drafts) {
    const body = document.getElementById('figshareDraftsModalBody');
    if (!body) {
        return;
    }
    if (!drafts || drafts.length === 0) {
        body.innerHTML = '<div class="alert alert-info mb-0">No drafts found.</div>';
        currentFigshareDrafts = [];
        return;
    }
    currentFigshareDrafts = drafts;
    let html = '<div class="mb-3"><h6 class="mb-0">Your draft datasets:</h6></div>';
    const draftItems = drafts.map(function (draft, index) {
        const linkBlock = figsharePublicLinkHtml(draft.url);
        return `
        <div class="card mb-2">
            <div class="card-body">
                <h6 class="card-title">${escapeHtml(draft.title || 'Untitled Dataset')}</h6>
                <p class="card-text mb-2">
                    <small class="text-muted">Last update: ${formatDate(draft.last_update_time)}</small>
                </p>
                ${draft.doi ? `<p class="card-text mb-2"><small class="text-muted">DOI: ${escapeHtml(draft.doi)}</small></p>` : ''}
                ${linkBlock}
                <button type="button" class="btn btn-primary btn-sm select-figshare-draft-btn" data-figshare-draft-index="${index}">
                    Select this draft
                </button>
            </div>
        </div>`;
    }).join('');
    body.innerHTML = html + draftItems;
    body.querySelectorAll('.select-figshare-draft-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const index = parseInt(this.getAttribute('data-figshare-draft-index'), 10);
            if (currentFigshareDrafts[index]) {
                selectFigshareDraft(currentFigshareDrafts[index]);
            }
        });
    });
}

async function selectFigshareDraft(draft) {
    const apiKey = ($('#figshareApiKeyInput').val() || '').trim().split(/\s+/).join('');
    if (!apiKey || !draft || draft.id == null) {
        showErrorMessage('Figshare API key and a draft selection are required.');
        return;
    }
    try {
        showLoadingMessage();
        const response = await fetch('/fetch_figshare_article', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey, article_id: draft.id }),
        });
        let data = {};
        try {
            data = await response.json();
        } catch (parseErr) {
            throw new Error('Invalid response from server.');
        }
        if (!response.ok) {
            throw new Error(data.detail || data.error || `Request failed (HTTP ${response.status})`);
        }
        if (data.error) {
            throw new Error(data.error);
        }
        applyParsedRepoMetadataToForm(data);
        markDataverseImportReady();
        figshareSelectedDraft = draft;
        zenodoSelectedDraft = null;
        setFigshareSendButtonState();
        const modalEl = document.getElementById('figshareDraftsModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            const inst = bootstrap.Modal.getInstance(modalEl);
            if (inst) {
                inst.hide();
            }
        }
        updateDataCompareButtonVisibility();
        showSuccessMessage('Data imported from Figshare.');
    } catch (err) {
        console.error('Figshare import error:', err);
        showErrorMessage(err.message || 'Failed to import from Figshare.');
    }
}

function zenodoDepositLinkHtml(url) {
    if (!url || typeof url !== 'string') {
        return '';
    }
    try {
        const u = new URL(url.trim());
        if (u.protocol !== 'https:') {
            return '';
        }
        const href = u.href.replace(/"/g, '&quot;');
        return `<p class="card-text mb-2"><small class="text-muted"><a href="${href}" target="_blank" rel="noopener noreferrer">Open deposit on Zenodo</a></small></p>`;
    } catch {
        return '';
    }
}

function getZenodoApiBaseUrlForRequest() {
    const raw = ($('#zenodoApiBaseUrlInput').val() || '').trim();
    // Strip the scheme before sending. Some reverse proxies/WAFs block request
    // bodies that contain a full "https://" URL (treated as SSRF/RFI). The server
    // re-adds https:// and enforces HTTPS for the outbound Zenodo request.
    const hostOnly = (raw || 'zenodo.org').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return hostOnly || 'zenodo.org';
}

function displayZenodoDraftsInModal(drafts) {
    const body = document.getElementById('zenodoDraftsModalBody');
    if (!body) {
        return;
    }
    if (!drafts || drafts.length === 0) {
        body.innerHTML = '<div class="alert alert-info mb-0">No drafts found.</div>';
        currentZenodoDrafts = [];
        return;
    }
    currentZenodoDrafts = drafts;
    let html = '<div class="mb-3"><h6 class="mb-0">Your draft depositions:</h6></div>';
    const draftItems = drafts.map(function (draft, index) {
        const linkBlock = zenodoDepositLinkHtml(draft.url);
        return `
        <div class="card mb-2">
            <div class="card-body">
                <h6 class="card-title">${escapeHtml(draft.title || 'Untitled deposition')}</h6>
                <p class="card-text mb-2">
                    <small class="text-muted">Last modified: ${formatDate(draft.modified)}</small>
                </p>
                ${linkBlock}
                <button type="button" class="btn btn-primary btn-sm select-zenodo-draft-btn" data-zenodo-draft-index="${index}">
                    Select this draft
                </button>
            </div>
        </div>`;
    }).join('');
    body.innerHTML = html + draftItems;
    body.querySelectorAll('.select-zenodo-draft-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const index = parseInt(this.getAttribute('data-zenodo-draft-index'), 10);
            if (currentZenodoDrafts[index]) {
                selectZenodoDraft(currentZenodoDrafts[index]);
            }
        });
    });
}

async function selectZenodoDraft(draft) {
    const accessToken = ($('#zenodoAccessTokenInput').val() || '').trim().split(/\s+/).join('');
    const apiBaseUrl = getZenodoApiBaseUrlForRequest();
    if (!accessToken || !draft || draft.id == null) {
        showErrorMessage('Zenodo access token and a draft selection are required.');
        return;
    }
    try {
        showLoadingMessage();
        const response = await fetch('/fetch_zenodo_deposition', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                access_token: accessToken,
                api_base_url: apiBaseUrl,
                deposition_id: draft.id,
            }),
        });
        let data = {};
        try {
            data = await response.json();
        } catch (parseErr) {
            throw new Error('Invalid response from server.');
        }
        if (!response.ok) {
            throw new Error(data.detail || data.error || `Request failed (HTTP ${response.status})`);
        }
        if (data.error) {
            throw new Error(data.error);
        }
        applyParsedRepoMetadataToForm(data);
        markDataverseImportReady();
        zenodoSelectedDraft = draft;
        figshareSelectedDraft = null;
        setFigshareSendButtonState();
        const modalEl = document.getElementById('zenodoDraftsModal');
        if (modalEl && typeof bootstrap !== 'undefined') {
            const inst = bootstrap.Modal.getInstance(modalEl);
            if (inst) {
                inst.hide();
            }
        }
        updateDataCompareButtonVisibility();
        showSuccessMessage('Data imported from Zenodo.');
    } catch (err) {
        console.error('Zenodo import error:', err);
        showErrorMessage(err.message || 'Failed to import from Zenodo.');
    }
}

// Fetch the user's draft datasets
async function fetchUserDrafts(apiToken, dataverseBaseUrl = DEFAULT_DATAVERSE_BASE_URL) {
    try {
        const response = await fetch('/fetch_user_drafts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                api_token: apiToken,
                dataverse_base_url: dataverseBaseUrl
            })
        });
        
        const data = await response.json();
        
        if (response.ok && data.drafts) {
            displayDrafts(data.drafts);
            if (data.count > 0) {
                showSuccessMessage(`Found ${data.count} draft dataset(s)`);
            }
        } else {
            // Show the error; keep any existing draft list
            if (data.error && !data.error.includes('Authentication')) {
                console.error('Error fetching drafts:', data.error);
            }
            $('#dataverseDraftsList').html('<div class="alert alert-info">No drafts found or unable to fetch drafts.</div>');
        }
    } catch (error) {
        console.error('Error fetching user drafts:', error);
        $('#dataverseDraftsList').html('<div class="alert alert-warning">Unable to fetch drafts. Please check your API token.</div>');
    }
}

function selectDraft(draft) {
    if (draft.doi) {
        $('#doiInput').val(draft.doi);
    } else if (draft.persistent_id) {
        // Convert persistent id to a DOI URL
        const doi = draft.persistent_id.startsWith('doi:') 
            ? `https://doi.org/${draft.persistent_id.replace('doi:', '')}`
            : draft.persistent_id;
        $('#doiInput').val(doi);
    }
    
    $('#dataverseDraftsList .card').removeClass('border-primary');
    $('#dataverseDraftsList .select-draft-btn').each(function() {
        const index = parseInt($(this).attr('data-draft-index'));
        if (currentDrafts[index] && currentDrafts[index].id === draft.id) {
            $(this).closest('.card').addClass('border-primary border-2');
            $(this).html('<i class="fas fa-check"></i> Selected').removeClass('btn-primary').addClass('btn-success');
        }
    });
    
    setTimeout(function() {
        $('#fetchApiButton').click();
    }, 300);
}

// Dataverse checkbox fetch handlers
document.getElementById('contributorsCheck').addEventListener('change', function() {
    checkDataverseUrlAndFetchData('contributors');
});

document.getElementById('dataTypeCheck').addEventListener('change', function() {
    checkDataverseUrlAndFetchData('dataType');
});

document.getElementById('dateCollectionCheck').addEventListener('change', function() {
    checkDataverseUrlAndFetchData('dateCollection');
});

document.getElementById('geoLocationCheck').addEventListener('change', function() {
    checkDataverseUrlAndFetchData('geoLocation');
});

document.getElementById('fundingCheck').addEventListener('change', function() {
    const value = dataverseMetadata && dataverseMetadata.funding;
    const label = document.getElementById('fundingLabel');
    if (!label) return;
    if (value) {
        label.textContent = value;
        label.classList.remove('text-muted', 'text-primary');
        label.classList.add('text-dark');
        const metaResult = document.getElementById('funding_meta_result');
        const metaContainer = document.getElementById('funding_meta_container');
        if (metaResult) metaResult.textContent = value;
        if (metaContainer) metaContainer.classList.remove('hidden');
    } else {
        label.textContent = dataversePlaceholderByField.funding;
        label.classList.remove('text-dark', 'text-primary');
        label.classList.add('text-muted');
    }
});

// Placeholder text shown when API/URL not used (README will use these in file)
var dataversePlaceholderByField = {
    'contributors': 'See metadata field Contributor.',
    'dataType': 'See metadata field Data Type.',
    'dateCollection': 'See metadata field Date of Collection.',
    'geoLocation': 'See metadata section Geospatial Metadata.',
    'funding': 'See metadata section Funding Information.'
};

function checkDataverseUrlAndFetchData(field) {
    let value = dataverseMetadata && dataverseMetadata[field];
    const label = document.getElementById(field + 'Label');
    if (!label) return;

    if (value) {
        if (field === 'contributors') {
            const parts = value.split(':').map(part => part.trim());
            let formattedValue = '';
            for (let i = 0; i < parts.length; i += 2) {
                if (i + 1 < parts.length) {
                    formattedValue += (formattedValue ? ', ' : '') + `${parts[i]} : ${parts[i + 1]}`;
                }
            }
            value = formattedValue || value;
        }
        label.textContent = value;
        label.classList.remove('text-muted', 'text-primary');
        label.classList.add('text-dark');
        const metaResult = document.getElementById(`${field}_meta_result`);
        const metaContainer = document.getElementById(`${field}_meta_container`);
        if (metaResult) metaResult.textContent = value;
        if (metaContainer) metaContainer.classList.remove('hidden');
    } else {
        label.textContent = dataversePlaceholderByField[field] || 'Check to retrieve from Dataverse';
        label.classList.remove('text-dark', 'text-primary');
        label.classList.add('text-muted');
    }
}

// Case-insensitive :contains selector
jQuery.expr[':'].contains = function(a, i, m) {
    return jQuery(a).text().toUpperCase()
        .indexOf(m[3].toUpperCase()) >= 0;
};

// Sharing and citation event handlers
document.getElementById('fetchButton').addEventListener('click', function() {
    const url = document.getElementById('privaturl').value;
    if (url) {
        fetchDatasetFromPreview(url);
    }
});

// Append Sharing list text to the textarea
function addSharingText(text) {
    const el = document.getElementById('sharing');
    if (!el) return;
    const current = el.value.trim();
    el.value = current ? current + '\n\n' + text : text;
    invokeUrgeSidebarTextareaRefresh();
}

// Append a Dataverse field to the Sharing textarea
// Prefer the Data Import cache so the API is not called again (avoids 403).
function fetchSharingDataFromDataverse(field) {
    const sharingEl = document.getElementById('sharing');
    if (!sharingEl) return;

    function formatAndAppend(data) {
        if (field === 'license' && data.license) {
            const block = 'Licenses/Restrictions: ' + data.license + '\n\n';
            const current = sharingEl.value.trim();
            sharingEl.value = current ? current + '\n\n' + block : block;
        } else if (field === 'relatedPublication' && data.relatedPublication) {
            const pubs = typeof data.relatedPublication === 'string' ? data.relatedPublication.split(';').map(s => s.trim()) : data.relatedPublication;
            if (pubs && pubs.length) {
                const block = 'Links to publications that cite or use the data:\n' + pubs.map(p => '- ' + p).join('\n') + '\n\n';
                const current = sharingEl.value.trim();
                sharingEl.value = current ? current + '\n\n' + block : block;
            }
        } else if (field === 'relatedDataset' && data.relatedDataset) {
            const sets = typeof data.relatedDataset === 'string' ? data.relatedDataset.split(';').map(s => s.trim()) : data.relatedDataset;
            if (sets && sets.length) {
                const block = 'Links/relationships to related data sets:\n' + sets.map(d => '- ' + d).join('\n') + '\n\n';
                const current = sharingEl.value.trim();
                sharingEl.value = current ? current + '\n\n' + block : block;
            }
        } else if (field === 'dataSources' && data.dataSources) {
            const sources = typeof data.dataSources === 'string' ? data.dataSources.split(';').map(s => s.trim()) : data.dataSources;
            if (sources && sources.length) {
                const block = 'Data sources:\n' + sources.map(s => '- ' + s).join('\n') + '\n\n';
                const current = sharingEl.value.trim();
                sharingEl.value = current ? current + '\n\n' + block : block;
            }
        }
    }

    // Use cached Data Import metadata when available
    if (cachedDataverseApiResponse) {
        const hasField = (field === 'license' && cachedDataverseApiResponse.license) ||
            (field === 'relatedPublication' && cachedDataverseApiResponse.relatedPublication) ||
            (field === 'relatedDataset' && cachedDataverseApiResponse.relatedDataset) ||
            (field === 'dataSources' && cachedDataverseApiResponse.dataSources);
        if (hasField) {
            formatAndAppend(cachedDataverseApiResponse);
            invokeUrgeSidebarTextareaRefresh();
            return;
        }
        alert('No data for this field in the previously fetched metadata. Fetch the dataset again from the Data Import section if the dataset was updated.');
        return;
    }

    alert('Please fetch data from Dataverse first. In the Data Import section, enter API Token and DOI, then click "Fetch Data from Dataverse via API" (or use Import via Private URL).');
}

// Append a citation to Sharing
function addCitation(type) {
    const sharingTextarea = document.getElementById('sharing');
    const currentText = sharingTextarea.value;
    
    if (!currentText.includes('Recommended citation:')) {
        sharingTextarea.value +=  `Recommended citation: ${type}`;
    } else {
        const lastIndex = currentText.lastIndexOf('Recommended citation:');
        const beforeText = currentText.substring(0, lastIndex);
        const afterText = currentText.substring(lastIndex);
        const citationLine = afterText.split('\n')[0];
        
        if (!citationLine.includes(type)) {
            const newCitation = citationLine + ', ' + type;
            sharingTextarea.value = beforeText + newCitation + afterText.substring(citationLine.length);
        }
    }
    invokeUrgeSidebarTextareaRefresh();
}

$(document).ready(function() {
    $('#citationLink').click(function(e) {
        e.preventDefault();
        const citationOptions = $('#citationOptions');
        citationOptions.toggle();
    });
});

function generateJsonFile() {
    recordButtonClick('json_file');
    const formData = gatherFormData();
    const jsonData = {
        general_information: {
            title: formData.title,
            doi: formData.doi,
            contact: {
                name: formData.name,
                institution: formData.institution,
                email: formData.email,
                orcid: formData.orcid
            },
            contributors: formData.contributors,
            data_type: formData.dataType,
            date_collection: formData.dateCollection,
            geo_location: formData.geoLocation,
            funding: formData.funding,
            license: formData.license,
            related_publication: formData.relatedPublication,
            related_dataset: formData.relatedDataset,
            data_sources: formData.dataSources
        },
        methodological_information: {
            description: formData.description,
            data_collection: formData.datacollection,
            data_processing: formData.dataprocessing,
            methodology: formData.methodology,
            methodology2: formData.methodology2,
            methodology3: formData.methodology3
        },
        file_information: {
            details: formData.fileinformation,
            files: formData.files
        },
        data_specific_information: {
            data_types: formData.dataTypes,
            variables: formData.variables,
            missing_data: formData.missingdata,
            data_scientific: formData.datascientific
        },
        other_details: {
            additional_info: formData.otherdetails
        },
        sharing: {
            details: formData.sharing,
            citation: formData.citation
        }
    };

    const jsonString = JSON.stringify(jsonData, null, 2);
    download('dataset_metadata.json', jsonString);
    clearApiCache();
}

// Grammar check via LanguageTool public API
async function checkGrammar(text) {
    const url = 'https://api.languagetool.org/v2/check';
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                'text': text,
                'language': 'en-US'
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error('Grammar check request failed: ' + (errText || response.status));
        }

        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Grammar check error:', error);
        throw error;
    }
}

function displayGrammarResults(results) {
    const resultDiv = document.querySelector('#grammarCheckResult');
    const suggestionsDiv = resultDiv.querySelector('.grammar-suggestions');
    if (!resultDiv || !suggestionsDiv) return;
    suggestionsDiv.innerHTML = '';

    if (results.matches && results.matches.length > 0) {
        const suggestions = results.matches.map(match => {
            const ctx = match.context || {};
            const snippet = (ctx.text || '').substring(ctx.offset || 0, (ctx.offset || 0) + (ctx.length || 0));
            const suggestion = (match.replacements && match.replacements.length > 0)
                ? (match.replacements[0].value || '')
                : 'No correction suggestion available';
            const msg = match.message || match.shortMessage || 'Issue found';
            return `
                <div class="grammar-issue mb-2 p-2 border-start border-3 border-warning bg-light">
                    <strong>Issue:</strong> ${escapeHtml(msg)}<br>
                    <strong>Problematic text:</strong> "${escapeHtml(snippet)}"<br>
                    <strong>Suggestion:</strong> ${escapeHtml(suggestion)}
                </div>
            `;
        }).join('');

        suggestionsDiv.innerHTML = suggestions;
    } else {
        suggestionsDiv.innerHTML = '<div class="alert alert-success mb-0">No grammar issues found!</div>';
    }

    resultDiv.style.display = 'block';
}

function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Run grammar check (called after user confirms in modal)
async function runGrammarCheck() {
    const grammarCheckBtn = document.getElementById('grammarCheckBtn');
    const descriptionText = document.getElementById('description').value;
    if (!grammarCheckBtn || !descriptionText.trim()) return;
    try {
        grammarCheckBtn.disabled = true;
        grammarCheckBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Checking...';
        const results = await checkGrammar(descriptionText);
        displayGrammarResults(results);
    } catch (error) {
        alert('An error occurred during grammar check: ' + error.message);
    } finally {
        grammarCheckBtn.disabled = false;
        grammarCheckBtn.textContent = 'Grammar Checker';
    }
}

// Grammar check and repository-import event handlers
document.addEventListener('DOMContentLoaded', function() {
    const grammarCheckBtn = document.getElementById('grammarCheckBtn');
    const grammarConsentModal = document.getElementById('grammarCheckConsentModal');
    const grammarConfirmBtn = document.getElementById('grammarCheckConfirmBtn');
    const grammarCancelBtn = document.getElementById('grammarCheckCancelBtn');

    if (grammarCheckBtn) {
        grammarCheckBtn.addEventListener('click', function() {
            const descriptionText = document.getElementById('description').value;
            if (!descriptionText.trim()) {
                alert('Please enter text to check.');
                return;
            }
            if (grammarConsentModal && typeof bootstrap !== 'undefined') {
                const modal = new bootstrap.Modal(grammarConsentModal);
                modal.show();
            } else {
                runGrammarCheck();
            }
        });
    }

    if (grammarConfirmBtn && grammarConsentModal && typeof bootstrap !== 'undefined') {
        grammarConfirmBtn.addEventListener('click', function() {
            const modal = bootstrap.Modal.getInstance(grammarConsentModal);
            if (modal) modal.hide();
            runGrammarCheck();
        });
    }

    if (grammarCancelBtn && grammarConsentModal && typeof bootstrap !== 'undefined') {
        grammarCancelBtn.addEventListener('click', function() {
            const modal = bootstrap.Modal.getInstance(grammarConsentModal);
            if (modal) modal.hide();
        });
    }
});

// Dataverse Metadata Import: API section first; "Import via Private URL" toggles to Private URL section
$(document).ready(function() {
    updateDataverseBaseUrlUi();

    $('#usePrivateUrlCheckbox').on('change', function() {
        if ($(this).is(':checked')) {
            $('#apiFields').hide();
            $('#urlField').show();
            $('#dataverseApiAlert').hide();
        } else {
            $('#apiFields').show();
            $('#urlField').hide();
            $('#dataverseDraftsList').empty();
            $('#dataverseApiAlert').show();
        }
    });

    $('#useDefaultDataverseCheckbox').on('change', function() {
        updateDataverseBaseUrlUi();
        checkUrl();
    });

    $('#customDataverseUrl').on('input change', function() {
        this.setCustomValidity('');
        checkUrl();
    });

    const repoTabDv = document.getElementById('repo-tab-dataverse');
    const repoTabFs = document.getElementById('repo-tab-figshare');
    const repoTabZn = document.getElementById('repo-tab-zenodo');
    if (repoTabDv) {
        repoTabDv.addEventListener('shown.bs.tab', function () {
            figshareSelectedDraft = null;
            zenodoSelectedDraft = null;
            setFigshareSendButtonState();
            const modalEl = document.getElementById('figshareDraftsModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                const inst = bootstrap.Modal.getInstance(modalEl);
                if (inst) {
                    inst.hide();
                }
            }
            const zenModalEl = document.getElementById('zenodoDraftsModal');
            if (zenModalEl && typeof bootstrap !== 'undefined') {
                const zinst = bootstrap.Modal.getInstance(zenModalEl);
                if (zinst) {
                    zinst.hide();
                }
            }
        });
    }
    if (repoTabFs) {
        repoTabFs.addEventListener('shown.bs.tab', function () {
            const draftsList = document.getElementById('dataverseDraftsList');
            if (draftsList) {
                draftsList.innerHTML = '';
            }
            currentDrafts = [];
            zenodoSelectedDraft = null;
            setFigshareSendButtonState();
            const zenModalEl = document.getElementById('zenodoDraftsModal');
            if (zenModalEl && typeof bootstrap !== 'undefined') {
                const zinst = bootstrap.Modal.getInstance(zenModalEl);
                if (zinst) {
                    zinst.hide();
                }
            }
        });
    }
    if (repoTabZn) {
        repoTabZn.addEventListener('shown.bs.tab', function () {
            const draftsList = document.getElementById('dataverseDraftsList');
            if (draftsList) {
                draftsList.innerHTML = '';
            }
            currentDrafts = [];
            figshareSelectedDraft = null;
            setFigshareSendButtonState();
            const figModalEl = document.getElementById('figshareDraftsModal');
            if (figModalEl && typeof bootstrap !== 'undefined') {
                const finst = bootstrap.Modal.getInstance(figModalEl);
                if (finst) {
                    finst.hide();
                }
            }
        });
    }

    $('#figshareApiKeyInput').on('input', function () {
        setFigshareSendButtonState();
    });

    $('#figshareConnectBtn').on('click', async function () {
        const apiKey = ($('#figshareApiKeyInput').val() || '').trim().split(/\s+/).join('');
        if (!apiKey) {
            showErrorMessage('Figshare API key is required.');
            return;
        }
        try {
            showLoadingMessage();
            const response = await fetch('/fetch_figshare_drafts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: apiKey }),
            });
            let data = {};
            try {
                data = await response.json();
            } catch (parseErr) {
                throw new Error('Invalid response from server.');
            }
            if (!response.ok) {
                throw new Error(data.detail || data.error || `Request failed (HTTP ${response.status})`);
            }
            displayFigshareDraftsInModal(data.drafts || []);
            const modalEl = document.getElementById('figshareDraftsModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                bootstrap.Modal.getOrCreateInstance(modalEl).show();
            }
            const n = (data.drafts || []).length;
            if (n === 0) {
                showSuccessMessage('No draft datasets found on Figshare.');
            } else {
                showSuccessMessage(`Found ${n} draft dataset(s) on Figshare.`);
            }
        } catch (error) {
            console.error('Figshare drafts error:', error);
            showErrorMessage(error.message || 'Failed to list Figshare drafts.');
        }
    });

    $('#zenodoConnectBtn').on('click', async function () {
        const accessToken = ($('#zenodoAccessTokenInput').val() || '').trim().split(/\s+/).join('');
        const apiBaseUrl = getZenodoApiBaseUrlForRequest();
        if (!accessToken) {
            showErrorMessage('Zenodo personal access token is required.');
            return;
        }
        try {
            showLoadingMessage();
            const response = await fetch('/fetch_zenodo_drafts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken, api_base_url: apiBaseUrl }),
            });
            let data = {};
            try {
                data = await response.json();
            } catch (parseErr) {
                throw new Error('Invalid response from server.');
            }
            if (!response.ok) {
                throw new Error(data.detail || data.error || `Request failed (HTTP ${response.status})`);
            }
            displayZenodoDraftsInModal(data.drafts || []);
            const modalEl = document.getElementById('zenodoDraftsModal');
            if (modalEl && typeof bootstrap !== 'undefined') {
                bootstrap.Modal.getOrCreateInstance(modalEl).show();
            }
            const n = (data.drafts || []).length;
            if (n === 0) {
                showSuccessMessage('No draft depositions found on Zenodo.');
            } else {
                showSuccessMessage(`Found ${n} draft deposition(s) on Zenodo.`);
            }
        } catch (error) {
            console.error('Zenodo drafts error:', error);
            showErrorMessage(error.message || 'Failed to list Zenodo drafts.');
        }
    });

    $('#fetchApiButton').on('click', async function() {
        const apiToken = $('#apiTokenInput').val().trim();
        const doi = $('#doiInput').val().trim();
        let dataverseBaseUrl = '';
        let cleanApiToken = '';
        if (!apiToken || !doi) {
            showErrorMessage('API Token and DOI address are required!');
            return;
        }
        setDataverseConnectionStatus(false);
        try {
            showLoadingMessage();
            dataverseBaseUrl = getSelectedDataverseBaseUrl();
            currentDataverseBaseUrl = dataverseBaseUrl;
            
            // Normalize the API token (strip all whitespace)
            cleanApiToken = apiToken.split(/\s+/).join('').trim();
            if (!cleanApiToken) {
                showErrorMessage('Invalid API Token. The token cannot be empty. Please check your API token.');
                return;
            }
            currentApiToken = cleanApiToken;
            currentDoi = doi;
            
            let persistentId = doi;
            if (doi.startsWith('http')) {
                persistentId = doi.split('doi.org/').pop();
            }
            const persistentIdEncoded = encodeURIComponent(`doi:${persistentId}`);
            
            // Call the Dataverse API from the browser to avoid WAF blocks on the app proxy
            const dataverseApiUrl = `${buildDataverseUrl(dataverseBaseUrl, '/api/v1/datasets/:persistentId')}?persistentId=${persistentIdEncoded}`;
            
            const response = await fetch(dataverseApiUrl, {
                method: 'GET',
                headers: {
                    'X-Dataverse-key': cleanApiToken,
                    'Accept': 'application/json'
                }
            });
            if (!response.ok) {
                let errorMsg = '';
                let userFriendlyMsg = '';
                
                if (response.status === 401) {
                    userFriendlyMsg = 'Authentication failed. Please check your API token.';
                } else if (response.status === 403) {
                    userFriendlyMsg = 'Access denied. The API token may be invalid or you do not have permission to access this dataset.';
                } else if (response.status === 404) {
                    userFriendlyMsg = 'Dataset not found. Please check the DOI address.';
                } else {
                    userFriendlyMsg = `Failed to retrieve data from Dataverse API (HTTP ${response.status}).`;
                }
                
                try {
                    const errorText = await response.text();
                    try {
                        const errorJson = JSON.parse(errorText);
                        if (errorJson.message) {
                            errorMsg = errorJson.message;
                            if (errorMsg.toLowerCase().includes('bad api key') || 
                                errorMsg.toLowerCase().includes('invalid api') ||
                                errorMsg.toLowerCase().includes('api key')) {
                                userFriendlyMsg = 'Invalid API token. Please check your API token and make sure it is correct.';
                            } else {
                                userFriendlyMsg = errorMsg;
                            }
                        } else if (errorJson.status && errorJson.status === 'ERROR') {
                            errorMsg = errorJson.message || errorJson.status;
                            userFriendlyMsg = errorMsg;
                        }
                    } catch (parseErr) {
                        if (errorText) {
                            errorMsg = errorText.substring(0, 200);
                            if (errorMsg.toLowerCase().includes('bad api key') || 
                                errorMsg.toLowerCase().includes('invalid api')) {
                                userFriendlyMsg = 'Invalid API token. Please check your API token and make sure it is correct.';
                            } else {
                                userFriendlyMsg = userFriendlyMsg || errorMsg;
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error reading response:', e);
                }
                
                throw new Error(userFriendlyMsg || errorMsg || `HTTP ${response.status}: ${response.statusText}`);
            }
            
            const datasetJson = await response.json();
            
            const data = await parseDataverseMetadata(datasetJson);
            applyParsedRepoMetadataToForm(data);

            setDataverseConnectionStatus(true);
            showSuccessMessage('Data fetched successfully from Dataverse API');
        } catch (error) {
            console.error('Fetch API Error:', error);
            console.error('Error Stack:', error.stack);
            const msg = String(error && error.message ? error.message : '');
            const networkLikeFailure =
                /Failed to fetch|NetworkError|Load failed|CORS|TypeError/i.test(msg);

            if (!networkLikeFailure) {
                showErrorMessage(msg || 'Failed to fetch Dataverse data.');
                return;
            }

            try {
                const backendResp = await fetch('/fetch_dataset_api', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        doi: doi,
                        api_token: cleanApiToken || apiToken,
                        dataverse_base_url: dataverseBaseUrl || DEFAULT_DATAVERSE_BASE_URL
                    })
                });
                if (!backendResp.ok) {
                    throw new Error(`Backend fallback failed (HTTP ${backendResp.status})`);
                }
                const backendData = await backendResp.json();
                if (backendData.error) {
                    throw new Error(backendData.error);
                }

                applyParsedRepoMetadataToForm(backendData);
                setDataverseConnectionStatus(true);
                showSuccessMessage('Data fetched successfully from Dataverse API (fallback mode).');
            } catch (fallbackErr) {
                console.error('Backend fallback error:', fallbackErr);
                showErrorMessage(fallbackErr.message || msg || 'Failed to fetch Dataverse data.');
            }
        }
    });

    // Check Files button handler
    $('#checkFilesButton').on('click', function() {
        const text = ($('#fileinformation').val() || '').toString();
        const results = analyzeFileList(text);
        renderFileCheckResults(results);
        const modalEl = document.getElementById('fileCheckModal');
        if (modalEl) {
            const m = new bootstrap.Modal(modalEl);
            m.show();
        }
    });
});

// HTML -> plain text (structure-preserving) helper
function htmlToPlainTextPreserveStructure(html) {
    if (!html || typeof html !== 'string') return '';
    let text = html;
    // Normalize line breaks for common block-level tags
    text = text.replace(/<\s*br\s*\/?>/gi, '\n');
    text = text.replace(/<\s*\/\s*p\s*>/gi, '\n\n');
    text = text.replace(/<\s*p[^>]*>/gi, '');
    text = text.replace(/<\s*\/\s*div\s*>/gi, '\n');
    text = text.replace(/<\s*div[^>]*>/gi, '');
    // Lists
    text = text.replace(/<\s*li[^>]*>/gi, '- ');
    text = text.replace(/<\s*\/\s*li\s*>/gi, '\n');
    text = text.replace(/<\s*\/\s*ul\s*>/gi, '\n');
    text = text.replace(/<\s*ul[^>]*>/gi, '');
    text = text.replace(/<\s*\/\s*ol\s*>/gi, '\n');
    text = text.replace(/<\s*ol[^>]*>/gi, '');
    // Headings
    text = text.replace(/<\s*h[1-6][^>]*>/gi, '');
    text = text.replace(/<\s*\/\s*h[1-6]\s*>/gi, '\n\n');
    // Links: keep anchor text and URL in parentheses
    text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\s*\/\s*a\s*>/gi, (m, href, label) => {
        // strip nested tags in label
        const lbl = label.replace(/<[^>]+>/g, '').trim();
        return `${lbl} (${href})`;
    });
    // Remove remaining tags
    text = text.replace(/<[^>]+>/g, '');
    // Decode entities using the browser
    const tmp = document.createElement('textarea');
    tmp.innerHTML = text;
    text = tmp.value;
    // Collapse excessive newlines and trim
    text = text.replace(/\u00A0/g, ' '); // non-breaking space
    text = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text;
}

// Parse Dataverse Native API JSON (mirrors the Python parser)
async function parseDataverseMetadata(datasetJson) {
    const metadata = {
        doi: datasetJson.data?.persistentUrl || ''
    };
    
    const citationBlock = datasetJson.data?.latestVersion?.metadataBlocks?.citation?.fields || [];
    
    for (const field of citationBlock) {
        try {
            if (field.typeName === 'title') {
                metadata.title = field.value || '';
            }
            if (field.typeName === 'author') {
                const authors = [];
                for (const author of (field.value || [])) {
                    if (author && author.authorName) {
                        const authorName = typeof author.authorName === 'string' 
                            ? author.authorName 
                            : author.authorName.value || String(author.authorName);
                        authors.push(authorName);
                    }
                    if (author && author.authorAffiliation) {
                        const affiliation = typeof author.authorAffiliation === 'string'
                            ? author.authorAffiliation
                            : author.authorAffiliation.value || String(author.authorAffiliation);
                        metadata.institution = affiliation;
                    }
                    if (author && author.authorIdentifierScheme && author.authorIdentifier) {
                        const scheme = (typeof author.authorIdentifierScheme === 'string'
                            ? author.authorIdentifierScheme
                            : author.authorIdentifierScheme.value || '').trim().toUpperCase();
                        if (scheme === 'ORCID') {
                            metadata.orcid = (typeof author.authorIdentifier === 'string'
                                ? author.authorIdentifier
                                : author.authorIdentifier.value || '').trim();
                        }
                    }
                }
                metadata.author = authors.join(', ');
            }
            if (field.typeName === 'dsDescription') {
                const desc = field.value || [{}];
                let rawDescription = '';
                if (Array.isArray(desc) && desc.length > 0 && typeof desc[0] === 'object' && desc[0].dsDescriptionValue) {
                    rawDescription = desc[0].dsDescriptionValue.value || '';
                } else {
                    rawDescription = String(desc);
                }
                metadata.description = htmlToPlainTextPreserveStructure(rawDescription);
            }
            if (field.typeName === 'datasetContact') {
                for (const contact of (field.value || [])) {
                    if (contact && typeof contact === 'object') {
                        if (contact.datasetContactEmail) {
                            const email = typeof contact.datasetContactEmail === 'string'
                                ? contact.datasetContactEmail
                                : contact.datasetContactEmail.value || String(contact.datasetContactEmail);
                            metadata.email = email;
                        }
                        if (contact.datasetContactName) {
                            const name = typeof contact.datasetContactName === 'string'
                                ? contact.datasetContactName
                                : contact.datasetContactName.value || String(contact.datasetContactName);
                            metadata.contact_name = name;
                        }
                        if (contact.datasetContactAffiliation) {
                            const affiliation = typeof contact.datasetContactAffiliation === 'string'
                                ? contact.datasetContactAffiliation
                                : contact.datasetContactAffiliation.value || String(contact.datasetContactAffiliation);
                            metadata.institution = affiliation;
                        }
                        if (contact.datasetContactIdentifier && !metadata.orcid) {
                            metadata.orcid = (typeof contact.datasetContactIdentifier === 'string'
                                ? contact.datasetContactIdentifier
                                : contact.datasetContactIdentifier.value || '').trim();
                        }
                    }
                }
            }
            if (field.typeName === 'contributor') {
                const contributors = [];
                for (const c of (field.value || [])) {
                    if (c && c.contributorName) {
                        const name = typeof c.contributorName === 'string'
                            ? c.contributorName
                            : c.contributorName.value || String(c.contributorName);
                        contributors.push(name);
                    }
                }
                metadata.contributors = contributors.join(', ');
            }
            if (field.typeName === 'kindOfData') {
                const val = field.value || '';
                if (Array.isArray(val)) {
                    metadata.dataType = val.map(v => String(v)).join(', ');
                } else {
                    metadata.dataType = String(val);
                }
            }
            if (field.typeName === 'dateOfCollection') {
                const val = field.value || '';
                if (Array.isArray(val) && val.length > 0 && val[0].dateOfCollectionStart) {
                    const dateRanges = [];
                    for (const v of val) {
                        const start = v.dateOfCollectionStart?.value || '';
                        const end = v.dateOfCollectionEnd?.value || '';
                        if (start && end) {
                            dateRanges.push(`${start} - ${end}`);
                        } else if (start) {
                            dateRanges.push(start);
                        } else if (end) {
                            dateRanges.push(end);
                        }
                    }
                    metadata.dateCollection = dateRanges.join(', ');
                } else if (Array.isArray(val)) {
                    metadata.dateCollection = val.map(v => {
                        if (typeof v === 'object' && v.date) {
                            return v.date;
                        }
                        return String(v);
                    }).join(', ');
                } else if (typeof val === 'object' && val.date) {
                    metadata.dateCollection = val.date;
                } else {
                    metadata.dateCollection = String(val);
                }
            }
            if (field.typeName === 'geographicCoverage') {
                const val = field.value || '';
                if (Array.isArray(val)) {
                    metadata.geoLocation = val.map(v => {
                        if (typeof v === 'object' && v.country) {
                            return v.country;
                        }
                        return String(v);
                    }).join(', ');
                } else if (typeof val === 'object' && val.country) {
                    metadata.geoLocation = val.country;
                } else {
                    metadata.geoLocation = String(val);
                }
            }
            if (field.typeName === 'grantNumber') {
                const grants = [];
                for (const g of (field.value || [])) {
                    if (g && g.grantNumberAgency) {
                        let agencyVal = typeof g.grantNumberAgency === 'string'
                            ? g.grantNumberAgency
                            : g.grantNumberAgency.value || String(g.grantNumberAgency);
                        
                        if (typeof agencyVal === 'string' && agencyVal.startsWith('https://ror.org/')) {
                            try {
                                const rorId = agencyVal.split('https://ror.org/').pop();
                                const rorApiUrl = `https://api.ror.org/v1/organizations/${rorId}`;
                                const rorResp = await fetch(rorApiUrl);
                                if (rorResp.ok) {
                                    const rorData = await rorResp.json();
                                    agencyVal = rorData.name || agencyVal;
                                }
                            } catch (rorErr) {
                                console.warn('ROR API error:', rorErr);
                            }
                        }
                        grants.push(agencyVal);
                    }
                }
                metadata.funding = grants.join(', ');
            }
            if (field.typeName === 'license') {
                const licVal = field.value || '';
                if (typeof licVal === 'object') {
                    const name = licVal.name || '';
                    const uri = licVal.uri || '';
                    if (name && uri) {
                        metadata.license = `${name} (${uri})`;
                    } else if (name) {
                        metadata.license = name;
                    } else if (uri) {
                        metadata.license = uri;
                    } else {
                        metadata.license = String(licVal);
                    }
                } else {
                    metadata.license = String(licVal);
                }
            }
            if (field.typeName === 'publication') {
                const pubs = field.value || [];
                if (Array.isArray(pubs)) {
                    const pubCitations = [];
                    for (const pub of pubs) {
                        if (pub && pub.publicationCitation) {
                            const citation = typeof pub.publicationCitation === 'string'
                                ? pub.publicationCitation
                                : pub.publicationCitation.value || '';
                            if (citation) {
                                pubCitations.push(citation);
                            }
                        }
                    }
                    metadata.relatedPublication = pubCitations.join('; ');
                }
            }
            if (field.typeName === 'relatedDatasets') {
                const datasets = field.value || [];
                if (Array.isArray(datasets)) {
                    const datasetList = [];
                    for (const d of datasets) {
                        if (typeof d === 'object' && d.relatedDataset) {
                            datasetList.push(d.relatedDataset);
                        } else if (typeof d === 'string') {
                            datasetList.push(d);
                        } else {
                            datasetList.push(String(d));
                        }
                    }
                    metadata.relatedDataset = datasetList.join('; ');
                } else {
                    metadata.relatedDataset = String(datasets);
                }
            }
            if (field.typeName === 'dataSources') {
                const sources = field.value || [];
                if (Array.isArray(sources)) {
                    metadata.dataSources = sources.map(s => String(s)).join('; ');
                } else {
                    metadata.dataSources = String(sources);
                }
            }
            if (field.typeName === 'productionPlace') {
                const places = field.value || [];
                if (Array.isArray(places)) {
                    const geoVal = places.map(p => String(p)).join(', ');
                    if (metadata.geoLocation) {
                        metadata.geoLocation += ', ' + geoVal;
                    } else {
                        metadata.geoLocation = geoVal;
                    }
                }
            }
        } catch (err) {
            console.error(`API field parse error: ${field.typeName || 'unknown'} -`, err);
        }
    }
    
    if (!metadata.doi) {
        metadata.doi = datasetJson.data?.persistentUrl || '';
    }
    if (!metadata.relatedPublication) {
        const pubs = datasetJson.data?.latestVersion?.relatedPublications || [];
        if (Array.isArray(pubs)) {
            metadata.relatedPublication = pubs.map(p => {
                if (typeof p === 'object' && p.publicationCitation) {
                    return p.publicationCitation;
                }
                return String(p);
            }).join('; ');
        } else {
            metadata.relatedPublication = String(pubs);
        }
    }
    if (!metadata.relatedDataset) {
        const datasets = datasetJson.data?.latestVersion?.relatedDatasets || [];
        if (Array.isArray(datasets)) {
            const datasetList = [];
            for (const d of datasets) {
                if (typeof d === 'object' && d.relatedDataset) {
                    datasetList.push(d.relatedDataset);
                } else if (typeof d === 'string') {
                    datasetList.push(d);
                } else {
                    datasetList.push(String(d));
                }
            }
            metadata.relatedDataset = datasetList.join('; ');
        } else {
            metadata.relatedDataset = String(datasets);
        }
    }
    if (!metadata.license) {
        const licenseObj = datasetJson.data?.latestVersion?.license || {};
        if (typeof licenseObj === 'object') {
            const name = licenseObj.name || '';
            const uri = licenseObj.uri || '';
            if (name && uri) {
                metadata.license = `${name} (${uri})`;
            } else if (name) {
                metadata.license = name;
            } else if (uri) {
                metadata.license = uri;
            } else {
                metadata.license = String(licenseObj);
            }
        } else if (typeof licenseObj === 'string') {
            metadata.license = licenseObj;
        }
    }
    const files = [];
    for (const f of (datasetJson.data?.latestVersion?.files || [])) {
        try {
            files.push({
                name: f.dataFile?.filename || '',
                type: f.dataFile?.contentType || '',
                size: f.dataFile?.filesize || '',
                deposit_date: f.dataFile?.publicationDate || ''
            });
        } catch (ferr) {
            console.error('API file parse error:', f, ferr);
        }
    }
    metadata.files = files;
    
    return metadata;
}

// Send Readme Dataverse
async function sendReadmeDataverse() {
    recordButtonClick('send_to_dataverse');
    var form = document.getElementById('readmeForm');
    if (!form) {
        console.error('Form not found');
        return;
    }

    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
    }

    try {
        const formData = gatherFormData();
        let readmeText = generateReadMeText(formData, false);
        const dataverseBaseUrl = getSelectedDataverseBaseUrl();
        currentDataverseBaseUrl = dataverseBaseUrl;
        
        // Prefer cached token/DOI, then fall back to the form fields
        const apiToken = currentApiToken || document.getElementById('apiTokenInput')?.value;
        const doi = currentDoi || document.getElementById('doi')?.value;
        
        console.log('API Token:', apiToken);
        console.log('DOI:', doi);
        
        if (!apiToken) {
            alert('API Token not found. Please check the API Token in the Dataverse Import section.');
            return;
        }
        
        if (!doi) {
            alert('DOI address not found. Please check the DOI address in the Dataverse Import section.');
            return;
        }

        const baseUrl = buildDataverseUrl(dataverseBaseUrl, '/api/v1');
        
        const metadataResponse = await fetch(`${baseUrl}/datasets/:persistentId?persistentId=${encodeURIComponent(doi)}`, {
            method: 'GET',
            headers: {
                'X-Dataverse-key': apiToken
            }
        });

        if (!metadataResponse.ok) {
            const errorText = await metadataResponse.text();
            throw new Error(`Error fetching metadata: ${errorText}`);
        }

        const metadata = await metadataResponse.json();
        const datasetId = metadata.data.id;
        console.log('Dataset ID:', datasetId);
        
        const blob = new Blob([readmeText], { type: 'text/plain' });
        const formDataToSend = new FormData();
        formDataToSend.append('file', blob, '00_Readme.txt');
        formDataToSend.append('jsonData', JSON.stringify({
            description: 'README file generated by DataverseUrge',
            categories: ['Documentation']
        }));

        const headers = {
            'X-Dataverse-key': apiToken
        };

        console.log('Sending request with headers:', headers);

        const response = await fetch(`${baseUrl}/datasets/${datasetId}/add`, {
            method: 'POST',
            headers: headers,
            body: formDataToSend
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API Response:', errorText);
            console.error('Response Headers:', Object.fromEntries(response.headers.entries()));
            throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        const result = await response.json();
        if (result.status === 'OK') {
            alert('README file has been successfully uploaded to Dataverse.');
        } else {
            throw new Error('File upload failed: ' + JSON.stringify(result));
        }

    } catch (error) {
        console.error('File upload error:', error);
        alert('An error occurred during file upload: ' + error.message);
    }
}

// Send the generated README to the selected Figshare draft article. Mirrors
// sendReadmeDataverse(). The Figshare API does not send CORS headers, so the
// browser cannot call it directly; the README and token are posted to our own
// /send_figshare_readme endpoint, which performs the four-step Figshare upload
// flow (initiate -> read upload URL -> PUT parts -> complete) server-side.
async function sendReadmeFigshare() {
    recordButtonClick('send_to_figshare');
    const form = document.getElementById('readmeForm');
    if (!form) {
        console.error('Form not found');
        return;
    }
    if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
    }

    const apiKey = (document.getElementById('figshareApiKeyInput')?.value || '').trim().split(/\s+/).join('');
    if (!apiKey) {
        alert('Figshare personal token not found. Please enter it in the Figshare import section.');
        return;
    }
    if (!figshareSelectedDraft || figshareSelectedDraft.id == null) {
        alert('Please select a Figshare draft first (Repository Connection > Figshare > Connect).');
        return;
    }

    try {
        const formData = gatherFormData();
        const readmeText = generateReadMeText(formData, false);

        const response = await fetch('/send_figshare_readme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                article_id: figshareSelectedDraft.id,
                readme_text: readmeText,
            }),
        });

        let result = {};
        try {
            result = await response.json();
        } catch (parseErr) {
            throw new Error('Invalid response from server.');
        }
        if (!response.ok) {
            throw new Error(result.detail || result.error || `Request failed (HTTP ${response.status})`);
        }
        if (result.status !== 'OK') {
            throw new Error(result.error || 'File upload failed.');
        }

        alert('README file has been successfully uploaded to Figshare.');
    } catch (error) {
        console.error('Figshare upload error:', error);
        alert('An error occurred during the Figshare upload: ' + error.message);
    }
}

async function fetchDatasetFromAPI() {
    const apiToken = document.getElementById('apiTokenInput')?.value;
    const doi = document.getElementById('doi')?.value;

    if (!apiToken || !doi) {
        alert('Please enter both API Token and DOI');
        return;
    }

    showLoadingMessage();
    try {
        const dataverseBaseUrl = getSelectedDataverseBaseUrl();

        currentApiToken = apiToken;
        currentDoi = doi;
        currentDataverseBaseUrl = dataverseBaseUrl;

        const response = await fetch('/fetch_dataset_api', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                doi: doi,
                api_token: apiToken,
                dataverse_base_url: dataverseBaseUrl
            })
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        cachedDataverseApiResponse = data;
        fillFormWithPreviewData(data);
        showSuccessMessage('Data fetched successfully from Dataverse API');
    } catch (error) {
        console.error('Error fetching data:', error);
        showErrorMessage(error.message);
    }
}

// Convert various size inputs to KB string (e.g., "123 KB")
function formatSizeKB(value) {
    try {
        if (typeof value === 'number') {
            const kb = value / 1024;
            return `${Math.round(kb)} KB`;
        }
        if (typeof value === 'string') {
            const s = value.trim().toLowerCase();
            const match = s.match(/([0-9]*\.?[0-9]+)/);
            if (!match) return value;
            const num = parseFloat(match[1]);
            let kb = num;
            if (s.includes('gb')) kb = num * 1024 * 1024;
            else if (s.includes('mb')) kb = num * 1024;
            else if (s.includes('kb')) kb = num;
            else if (s.includes('b')) kb = num / 1024; // bytes
            else kb = num; // assume already KB if unitless text
            return `${Math.round(kb)} KB`;
        }
        return '';
    } catch (e) {
        console.warn('formatSizeKB error:', e);
        return String(value);
    }
}

// ---------- File quality check utilities ----------
function analyzeFileList(fileInfoText) {
    const lines = fileInfoText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const results = [];

    // Extract filenames from "name (type) - size - Upload Date" pattern
    const filenames = lines.map(l => {
        const beforeDash = l.split(' - ')[0];
        const namePart = beforeDash.includes('(') ? beforeDash.split('(')[0] : beforeDash;
        return namePart.trim();
    });

    const bannedChars = /[\\\/\?\:\*"\><\|#%\{\}\^\[\]~`ÅåÆæØø]/g; // includes Scandinavian letters
    const archiveBad = ['.tar.gz', '.7z', '.rar'];
    const archiveOk = ['.zip', '.tar'];
    const prefTables = ['.csv', '.tsv', '.txt'];
    const warnExcel = ['.xlsx'];
    const textOk = ['.txt', '.md'];
    const warnDocx = ['.docx'];
    const imageOk = ['.tiff', '.tif', '.png', '.jpg', '.jpeg', '.svg'];
    const imageWarn = ['.psd', '.gif', '.bmp', '.raw'];
    const audioOk = ['.wav', '.aiff', '.flac'];
    const audioWarn = ['.mp3', '.m4a', '.wma', '.ogg', '.ape'];
    const videoOk = ['.mp4'];
    const videoWarn = ['.avi', '.mov', '.wmv', '.flv'];
    const slideWarn = ['.pptx'];
    const codeOk = ['.xml', '.html', '.css', '.js', '.md'];
    const statsPref = ['.r', '.rdata', '.dat', '.sps', '.do'];
    const statsWarn = ['.sav', '.por', '.dta', '.sas'];

    // README check
    const hasReadme = filenames.some(fn => /^0{1,2}_?readme\.(txt|pdf)$/i.test(fn));
    if (!hasReadme) {
        results.push({
            original: 'README', status: 'Error', reason: 'README required but not found',
            action: 'Add 00_ReadMe.txt or 0_ReadMe.pdf', newName: '00_ReadMe.txt', newFormat: 'txt'
        });
    } else {
        // If exists but not prefixed with 00_
        const badReadme = filenames.find(fn => /readme\.(txt|pdf)$/i.test(fn) && !/^00_/i.test(fn));
        if (badReadme) {
            const ext = getExt(badReadme);
            results.push({
                original: badReadme, status: 'Warning', reason: 'README should start with 00_',
                action: 'Rename to start with 00_', newName: `00_ReadMe${ext}`, newFormat: ext.replace('.', '')
            });
        }
    }

    // Count check
    if (filenames.length > 300) {
        results.push({
            original: 'Dataset', status: 'Warning', reason: 'More than 300 files',
            action: 'Consider zipping or splitting into sub-datasets', newName: '', newFormat: ''
        });
    }

    filenames.forEach(fn => {
        const base = fn.trim();
        const ext = getExt(base);
        const lower = base.toLowerCase();
        const baseNoExt = ext ? base.slice(0, -ext.length) : base;

        // Skip the synthetic README rows handled above
        if (/^0{1,2}_?readme\.(txt|pdf)$/i.test(base)) {
            results.push({ original: base, status: 'OK', reason: 'README present', action: 'None', newName: '', newFormat: '' });
            return;
        }

        // Naming checks
        let status = 'OK';
        let reason = 'Meets naming and format preferences';
        let action = 'None';
        let newName = '';
        let newFormat = '';

        // spaces
        if (/\s/.test(baseNoExt)) {
            status = elevate(status, 'Warning');
            reason = 'Filename contains spaces';
            action = 'Use underscores instead of spaces';
            newName = suggestNewName(baseNoExt.replace(/\s+/g, '_'), ext);
        }
        // length
        if (baseNoExt.length > 25) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Filename exceeds 25 characters');
            action = append(action, 'Shorten while keeping it descriptive');
            if (!newName) newName = suggestNewName(truncateName(baseNoExt, 25), ext);
        }
        // banned chars
        if (bannedChars.test(base)) {
            status = elevate(status, 'Error');
            reason = append(reason, 'Contains prohibited characters');
            action = append(action, 'Replace with ASCII letters, digits, _ or -');
            if (!newName) newName = suggestNewName(base.replace(bannedChars, '_'), ext);
        }

        // Archive rules
        if (archiveBad.some(suf => lower.endsWith(suf))) {
            status = elevate(status, 'Error');
            reason = append(reason, 'Only .zip or .tar allowed; no compressed multi-archives');
            action = append(action, 'Use uncompressed .tar or a single .zip');
            newName = base.replace(/\.tar\.gz$/i, '.tar');
            newFormat = newName.endsWith('.tar') ? 'tar' : '';
        } else if (archiveOk.some(suf => lower.endsWith(suf))) {
            // ok
        }

        // Preferred formats by type
        if (warnExcel.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Excel is not preferred for long-term; CSV suggested');
            action = append(action, 'Export as UTF-8 CSV');
            newName = suggestNewName(baseNoExt, '.csv');
            newFormat = 'csv';
            // structural suggestion
            results.push({ original: base, status, reason: append(reason, 'Add structural checks: one table per file, header in first row, no spaces in variable names'), action, newName, newFormat });
            return;
        }

        if (prefTables.includes(ext)) {
            // structural suggestion row
            results.push({ original: base, status: 'OK', reason: 'Preferred tabular format; consider structural checks', action: 'Ensure one table per file; headers in first row', newName: '', newFormat: ext.replace('.', '') });
            return;
        }

        if (warnDocx.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Text should be plain .txt or add PDF/A');
            action = append(action, 'Save as 0_ReadMe.txt or additionally export PDF/A');
            newName = suggestNewName(baseNoExt, '.txt');
            newFormat = 'txt';
        }

        if (imageWarn.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Prefer TIFF/PNG/JPG/SVG for images');
            action = append(action, 'Convert to TIFF or PNG keeping originals if needed');
            newFormat = 'tiff';
        }
        if (audioWarn.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Prefer WAV/AIFF/FLAC for analysis');
            action = append(action, 'Convert to WAV or FLAC');
            newFormat = 'wav';
        }
        if (videoWarn.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Prefer MP4 for video');
            action = append(action, 'Transcode to MP4 (H.264/AAC)');
            newFormat = 'mp4';
        }
        if (slideWarn.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Add PDF/A along with original slides');
            action = append(action, 'Export an additional PDF/A');
            newFormat = 'pdfa';
        }
        if (statsWarn.includes(ext)) {
            status = elevate(status, 'Warning');
            reason = append(reason, 'Consider open text exports and include command scripts');
            action = append(action, 'Export to open text formats and include .do/.sps scripts');
        }

        // If we flagged anything, push; else push OK row
        results.push({
            original: base,
            status,
            reason,
            action,
            newName,
            newFormat
        });
    });

    return results;

    function getExt(name) {
        const i = name.lastIndexOf('.');
        return i >= 0 ? name.slice(i).toLowerCase() : '';
    }
    function suggestNewName(baseNoExt, ext) {
        return `${sanitize(baseNoExt)}${ext || ''}`;
    }
    function sanitize(s) {
        return s
            .replace(/[\s]+/g, '_')
            .replace(/[\\\/\?\:\*"\><\|#%\{\}\^\[\]~`ÅåÆæØø]/g, '_')
            .slice(0, 25);
    }
    function truncateName(s, n) { return s.slice(0, n); }
    function elevate(current, desired) {
        const order = { 'OK': 0, 'Warning': 1, 'Error': 2 };
        return order[desired] > order[current] ? desired : current;
    }
    function append(a, b) { return a === 'None' || a === 'Meets naming and format preferences' ? b : `${a}; ${b}`; }
}

function renderFileCheckResults(results) {
    const tbody = document.getElementById('fileCheckTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!results || results.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-muted">No files to analyze.</td></tr>`;
        return;
    }
    const frag = document.createDocumentFragment();
    results.forEach(r => {
        const tr = document.createElement('tr');
        const rowClass = r.status === 'Error' ? 'table-danger' : (r.status === 'Warning' ? 'table-warning' : 'table-success');
        tr.className = rowClass;
        const badge = r.status === 'Error' ? 'badge bg-danger' : (r.status === 'Warning' ? 'badge bg-warning text-dark' : 'badge bg-success');
        tr.innerHTML = `
            <td>${escapeHtml(r.original || '')}</td>
            <td><span class="${badge}">${escapeHtml(r.status || '')}</span></td>
            <td>${escapeHtml(r.reason || '')}</td>
            <td>${escapeHtml(r.action || '')}</td>
            <td>${escapeHtml(r.newName || '')}</td>
            <td>${escapeHtml(r.newFormat || '')}</td>
        `;
        frag.appendChild(tr);
    });
    tbody.appendChild(frag);

    function escapeHtml(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }
}

(function () {
    const URGE_SIDEBAR_SECTIONS = [
        { section: 1, items: [] },
        {
            section: 2,
            items: [
                { id: 'title', label: 'Title of Dataset' },
                { id: 'doi', label: 'DOI' },
                { id: 'name', label: 'Surname, Name' },
                { id: 'institution', label: 'Institution' },
                { id: 'email', label: 'Email' },
                { id: 'orcid', label: 'ORCID' },
                { id: 'description', label: 'Description of Dataset' }
            ]
        },
        {
            section: 3,
            items: [
                { id: 'methodology', label: 'Sources and methods (data collection / generation)' },
                { id: 'methodology2', label: 'Methods for processing the data' },
                { id: 'methodology3', label: 'Facility, standards, conditions, quality assurance' }
            ]
        },
        { section: 4, items: [{ id: 'fileinformation', label: 'File list' }] },
        { section: 5, items: [{ id: 'datascientific', label: 'Data-specific information' }] },
        { section: 6, items: [{ id: 'sharing', label: 'Sharing notes' }] }
    ];

    const URGE_SCROLL_SPY_SECTION_IDS = [
        'list-item-1',
        'list-item-2',
        'list-item-3',
        'list-item-4',
        'list-item-5',
        'list-item-6'
    ];

    function initUrgeSidebarAccordion() {
        const acc = document.getElementById('urgeSidebarAccordion');
        if (!acc) return;

        function refreshSidebarTextareaStates() {
            acc.querySelectorAll('.urge-sidebar-tree-item[data-field-id]').forEach((li) => {
                const id = li.getAttribute('data-field-id');
                const fieldEl = id ? document.getElementById(id) : null;
                const labelBtn = li.querySelector('.urge-sidebar-tree-label');
                const led = li.querySelector('.urge-sidebar-led');
                const has = !!(fieldEl && String(fieldEl.value || '').trim());
                if (led) {
                    led.classList.toggle('urge-sidebar-led--ok', has);
                    led.classList.toggle('urge-sidebar-led--missing', !has);
                }
                if (labelBtn) {
                    labelBtn.classList.remove('text-danger');
                    labelBtn.classList.add('text-body');
                }
            });
        }

        window.refreshUrgeSidebarTextareaStates = refreshSidebarTextareaStates;

        URGE_SIDEBAR_SECTIONS.forEach((def) => {
            const ul = acc.querySelector(`ul[data-urge-section="${def.section}"]`);
            if (!ul) return;
            if (!def.items.length) {
                const li = document.createElement('li');
                li.className = 'text-muted small urge-sidebar-tree-empty-msg';
                li.textContent = 'No checklist fields in this section.';
                ul.appendChild(li);
                return;
            }
            def.items.forEach((item) => {
                if (item.kind === 'subheading') {
                    const sub = document.createElement('li');
                    sub.className = 'urge-sidebar-tree-subheading';
                    sub.textContent = item.label;
                    ul.appendChild(sub);
                    return;
                }
                const li = document.createElement('li');
                li.className = 'urge-sidebar-tree-item';
                li.setAttribute('data-field-id', item.id);
                const row = document.createElement('div');
                row.className = 'd-flex align-items-start justify-content-between gap-2 urge-sidebar-tree-row';
                const label = document.createElement('button');
                label.type = 'button';
                label.className =
                    'btn btn-link text-start text-decoration-none p-0 urge-sidebar-tree-label flex-grow-1 text-body';
                label.textContent = item.label;
                const led = document.createElement('span');
                led.className = 'urge-sidebar-led urge-sidebar-led--missing';
                led.setAttribute('aria-hidden', 'true');
                row.appendChild(label);
                row.appendChild(led);
                li.appendChild(row);
                ul.appendChild(li);
                label.addEventListener('click', () => {
                    const el = document.getElementById(item.id);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.focus({ preventScroll: true });
                    }
                });
            });
        });

        /* Nested <form> under General Information can leave inputs outside #readmeForm in the DOM; use main column. */
        const mainCol = document.getElementById('mainContent');
        const form = document.getElementById('readmeForm');
        const refreshOnFieldInput = (e) => {
            const t = e.target;
            if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) refreshSidebarTextareaStates();
        };
        if (mainCol) {
            mainCol.addEventListener('input', refreshOnFieldInput, true);
            mainCol.addEventListener('change', refreshOnFieldInput, true);
        } else if (form) {
            form.addEventListener('input', refreshOnFieldInput, true);
            form.addEventListener('change', refreshOnFieldInput, true);
        }

        refreshSidebarTextareaStates();
        // Safety net: keep checklist in sync even when values are set programmatically.
        setInterval(refreshSidebarTextareaStates, 1500);

        window.addEventListener('focus', refreshSidebarTextareaStates);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refreshSidebarTextareaStates();
        });

        acc.querySelectorAll('[data-urge-direct-scroll-target]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const targetId = btn.getAttribute('data-urge-direct-scroll-target');
                if (!targetId) return;
                const target = document.getElementById(targetId);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });

        acc.querySelectorAll('[data-bs-toggle="collapse"]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sel = btn.getAttribute('data-bs-target');
                const col = sel ? document.querySelector(sel) : null;
                const scrollId = col && col.getAttribute('data-urge-scroll-target');
                if (!scrollId || !col) return;
                const onShown = () => {
                    const target = document.getElementById(scrollId);
                    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                };
                col.addEventListener('shown.bs.collapse', onShown, { once: true });
            });
        });

        const scrollSpyHost = document.querySelector('.scrollspy-example');
        if (scrollSpyHost && typeof bootstrap !== 'undefined') {
            scrollSpyHost.addEventListener('activate.bs.scrollspy', (ev) => {
                const a = ev.relatedTarget;
                if (!a || !a.getAttribute) return;
                const href = a.getAttribute('href');
                if (!href || href.charAt(0) !== '#') return;
                const id = href.slice(1);
                const ix = URGE_SCROLL_SPY_SECTION_IDS.indexOf(id);
                if (ix < 0) return;
                const collapseId = `urgeSidebarNav${ix + 1}`;
                const collapse = document.getElementById(collapseId);
                if (collapse && bootstrap.Collapse) {
                    bootstrap.Collapse.getOrCreateInstance(collapse, { toggle: false }).show();
                }
            });
        }
    }

    document.addEventListener('DOMContentLoaded', initUrgeSidebarAccordion);
})();

