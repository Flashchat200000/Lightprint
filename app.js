'use strict';

if (window.engine) {
window.location.reload();
}

(function() {

code
Code
download
content_copy
expand_less
const CONSTANTS = {
    ROLES: { RECEIVER: 'receiver', TRANSMITTER: 'transmitter' },
    MODES: { FLICKER: 'flicker', STABLE: 'stable', DATA: 'data' },
    STATES: { BOOTING: 'booting', IDLE: 'idle', STABILIZING: 'stabilizing', CAPTURING: 'capturing', PROCESSING: 'processing', ERROR: 'error' },
    CSS: { HIDDEN: 'hidden', LOADING: 'loading' },
    MANCHESTER: {
        START_SEQUENCE: ['1', '0', '1', '0', '1', '0', '1', '0'],
        COLOR_MAP: { 'SIGNAL': '#FF0000', 'NO_SIGNAL': '#000000' }
    },
    CONFIG: {
        ROI_SCALE: 0.3, STABILITY_THRESHOLD: 2.5, STABILITY_CHECK_DURATION_MS: 1500,
        TRANSMIT_BIT_DURATION_MS: 40, HUE_SIGNAL_TARGET: 0, HUE_TOLERANCE: 25,
        SATURATION_MIN: 0.6, VALUE_MIN: 0.4,
        FUSION_SIMILARITY_THRESHOLD: 0.90, 
        TEXTURE_CONFIDENCE_THRESHOLD: 0.4,
        SHAPE_CONFIDENCE_THRESHOLD: 0.1,
        SAMPLE_TARGET_MS: 16, FLICKER_CORR_THRESHOLD: 0.5,
        FLICKER_DTW_THRESHOLD: 0.35, MIN_SIGNAL_STD: 1.5, XCORR_MAX_LAG: 15,
    }
};

const workerScript = `
    const _math = {
        crc8(data) { let crc = 0; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) { crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1; } } return crc & 0xFF; },
        processPacket(bitStream) {
            const crc8 = (data) => { let crc = 0; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) { crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1; } } return crc & 0xFF; };
            const lenBits = bitStream.slice(0, 8);
            if (lenBits.length < 8) throw new Error("Не удалось прочитать длину.");
            const payloadLenInBytes = parseInt(lenBits, 2);
            const dataBytes = [];
            for(let i = 8; i < 8 + payloadLenInBytes * 8; i += 8){ dataBytes.push(parseInt(bitStream.slice(i, i + 8), 2)); }
            const crcEnd = 8 + payloadLenInBytes * 8 + 8;
            if (bitStream.length < crcEnd) throw new Error("Пакет неполный.");
            const receivedCrc = parseInt(bitStream.slice(crcEnd - 8, crcEnd), 2);
            const dataForCrc = new Uint8Array([payloadLenInBytes, ...dataBytes]);
            const calculatedCrc = crc8(dataForCrc);
            if (receivedCrc !== calculatedCrc) { throw new Error(\`Ошибка CRC! Ожидалось: \${calculatedCrc}, получено: \${receivedCrc}\`); }
            return new TextDecoder().decode(new Uint8Array(dataBytes));
        },
        dtwDistance(a, b) { if (a.length > b.length) [a, b] = [b, a]; const n = a.length, m = b.length; if (n === 0) return m > 0 ? Infinity : 0; let prevRow = new Float64Array(m + 1).fill(Infinity); let currRow = new Float64Array(m + 1).fill(Infinity); prevRow[0] = 0; for (let i = 1; i <= n; i++) { currRow[0] = Infinity; for (let j = 1; j <= m; j++) { const cost = Math.abs(a[i - 1] - b[j - 1]); currRow[j] = cost + Math.min(prevRow[j], prevRow[j-1], currRow[j-1]); } prevRow.set(currRow); } return prevRow[m] / (n + m); }
    };
    self.onmessage = (e) => { const { id, type, payload } = e.data; try { let result; if (type === 'processPacket') result = _math.processPacket(payload); else if (type === 'dtw') result = _math.dtwDistance(payload.a, payload.b); self.postMessage({ id, result }); } catch (error) { self.postMessage({ id, error: error.message }); } };
`;

class WorkerService {
    constructor(script) { const blob = new Blob([script], { type: 'application/javascript' }); this.worker = new Worker(URL.createObjectURL(blob)); this.requests = new Map(); this.reqId = 0; this.worker.onmessage = (e) => { const { id, result, error } = e.data; if (this.requests.has(id)) { const { resolve, reject } = this.requests.get(id); if (error) { reject(new Error(error)); } else { resolve(result); } this.requests.delete(id); } }; }
    exec(type, payload) { return new Promise((resolve, reject) => { const id = this.reqId++; this.requests.set(id, { resolve, reject }); this.worker.postMessage({ id, type, payload }); }); }
}

class UIController {
    constructor() { this.dom = {}; this.roiRect = { x: 0, y: 0, w: 0, h: 0 }; this.frameCtx = null; }
    init() { this.dom = { roleSwitcher: document.getElementById('role-switcher'), mainDisplay: document.querySelector('.main-display'), loaderOverlay: document.getElementById('loader-overlay'), receiverControls: document.getElementById('receiver-controls'), transmitterControls: document.getElementById('transmitter-controls'), video: document.getElementById('cam'), status: document.getElementById('status'), progressFill: document.getElementById('progressFill'), plots: document.getElementById('plots'), roiOverlay: document.getElementById('roi-overlay'), frameCanvas: document.getElementById('frame'), enrollBtn: document.getElementById('enrollBtn'), verifyBtn: document.getElementById('verifyBtn'), clearBtn: document.getElementById('clearBtn'), switchCamBtn: document.getElementById('switchCamBtn'), receiveBtn: document.getElementById('receiveBtn'), authControls: document.getElementById('auth-controls'), signalType: document.getElementById('signalType'), transmitter: document.getElementById('transmitter'), dataToSend: document.getElementById('data-to-send'), sendBtn: document.getElementById('sendBtn'), }; this.frameCtx = this.dom.frameCanvas.getContext('2d', { willReadFrequently: true }); }
    onModelReady() { this.dom.loaderOverlay.classList.add('hidden'); }
    setupRoi() { const video = this.dom.video; const w = video.clientWidth, h = video.clientHeight; if (w === 0 || h === 0) return; this.dom.roiOverlay.width = w; this.dom.roiOverlay.height = h; const roiSize = Math.min(w, h) * CONSTANTS.CONFIG.ROI_SCALE; this.roiRect = { w: roiSize, h: roiSize, x: (w - roiSize) / 2, y: (h - roiSize) / 2 }; const {x, y, w: rw, h: rh} = this.roiRect; const leftPx = Math.round(x), topPx = Math.round(y), rightPx = Math.round(x + rw), bottomPx = Math.round(y + rh); document.documentElement.style.setProperty('--clip-path', `polygon(0px 0px, 0px ${h}px, ${leftPx}px ${h}px, ${leftPx}px ${topPx}px, ${rightPx}px ${topPx}px, ${rightPx}px ${bottomPx}px, ${leftPx}px ${bottomPx}px, ${leftPx}px ${h}px, ${w}px ${h}px, ${w}px 0px)`); }
    updateRoiStatus(status) { this.dom.roiOverlay.dataset.status = status; }
    updateState(engineState, operation = '') { const isIdle = engineState === CONSTANTS.STATES.IDLE; const allButtons = [ this.dom.enrollBtn, this.dom.verifyBtn, this.dom.clearBtn, this.dom.switchCamBtn, this.dom.receiveBtn, this.dom.roleSwitcher, this.dom.signalType ]; allButtons.forEach(b => { b.disabled = !isIdle; }); if (!isIdle) { const busyBtn = operation === 'enroll' ? this.dom.enrollBtn : operation === 'verify' ? this.dom.verifyBtn : operation === 'data' ? this.dom.receiveBtn : null; if (busyBtn) { busyBtn.disabled = false; if (busyBtn.id === 'receiveBtn') busyBtn.textContent = 'Stop'; else { busyBtn.classList.add(CONSTANTS.CSS.LOADING); busyBtn.dataset.originalText = busyBtn.textContent; busyBtn.textContent = ''; } } } else { allButtons.forEach(b => { if (window.engine.modelReady || !['enrollBtn', 'verifyBtn', 'clearBtn'].includes(b.id)) b.disabled = false; if (b.classList.contains(CONSTANTS.CSS.LOADING)) { b.classList.remove(CONSTANTS.CSS.LOADING); if (b.dataset.originalText) { b.textContent = b.dataset.originalText; delete b.dataset.originalText; } } }); if(this.dom.receiveBtn) this.dom.receiveBtn.textContent = 'Start Receive'; } }
    setStatus(text, type = 'info') { this.dom.status.textContent = text; this.dom.status.dataset.type = type; }
    setProgress(percentage) { this.dom.progressFill.style.width = `${percentage}%`; }
    plotSignal(data, title) { const plotDiv = document.createElement('div'); plotDiv.className = 'plot'; const titleEl = document.createElement('p'); titleEl.textContent = title; titleEl.style.cssText = "margin:0; padding: 4px 8px; font-size: 12px; background: #444; color: white;"; plotDiv.appendChild(titleEl); const cvs = document.createElement('canvas'); cvs.width = 300; cvs.height = 100; plotDiv.appendChild(cvs); this.dom.plots.prepend(plotDiv); const g = cvs.getContext('2d'); g.fillStyle="#fff"; g.fillRect(0,0,300,100); if (data && data.length > 1) { g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#007aff'; g.lineWidth=1.5; g.beginPath(); const min=Math.min(...data), max=Math.max(...data), range=(max-min)||1; data.forEach((v, i) => { const x = (i/(data.length-1))*300; const y = 95-((v-min)/range)*90; i===0 ? g.moveTo(x,y) : g.lineTo(x,y); }); g.stroke(); } while (this.dom.plots.children.length > 4) this.dom.plots.removeChild(this.dom.plots.lastChild); }
    clearPlots() { this.dom.plots.innerHTML = ''; }
    switchRole(role, engine) { if (role === CONSTANTS.ROLES.RECEIVER) { this.dom.receiverControls.classList.remove(CONSTANTS.CSS.HIDDEN); this.dom.transmitterControls.classList.add(CONSTANTS.CSS.HIDDEN); this.dom.transmitter.classList.add(CONSTANTS.CSS.HIDDEN); engine.startStream(); } else { this.dom.receiverControls.classList.add(CONSTANTS.CSS.HIDDEN); this.dom.transmitterControls.classList.remove(CONSTANTS.CSS.HIDDEN); this.dom.transmitter.classList.remove(CONSTANTS.CSS.HIDDEN); this.setStatus("Готов к передаче.", 'info'); engine.stopStream(); this.dom.sendBtn.disabled = false; } }
    updateUIMode() { const mode = this.dom.signalType.value; if (mode === CONSTANTS.MODES.DATA) { this.dom.authControls.classList.add(CONSTANTS.CSS.HIDDEN); this.dom.receiveBtn.classList.remove(CONSTANTS.CSS.HIDDEN); } else { this.dom.authControls.classList.remove(CONSTANTS.CSS.HIDDEN); this.dom.receiveBtn.classList.add(CONSTANTS.CSS.HIDDEN); } }
}

class LightprintEngine {
    constructor(ui, workerService) {
        this.ui = ui; this.worker = workerService; this.state = CONSTANTS.STATES.BOOTING;
        this.templates = { flicker: [], stable: [] };
        this.stream = null; this.currentFacingMode = 'environment'; this.model = null; this.modelReady = false;
        this.isReceiving = false; this.abortController = null;
        this.onStateChange = () => {}; this.onStatusUpdate = () => {}; this.onProgressUpdate = () => {}; this.onPlotReady = () => {};
    }

    _math = {
        cosineSimilarity(vecA, vecB) { let dotProduct = 0.0, normA = 0.0, normB = 0.0; for (let i = 0; i < vecA.length; i++) { dotProduct += vecA[i] * vecB[i]; normA += vecA[i] * vecA[i]; normB += vecB[i] * vecB[i]; } if (normA === 0 || normB === 0) return 0; return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)); },
        mean: a => a.reduce((x, y) => x + y, 0) / a.length || 0,
        std(a, m) { m = m ?? this.mean(a); return Math.sqrt(this.mean(a.map(x => (x - m) ** 2))); },
        normalize(a) { const m = this.mean(a); const s = this.std(a, m) || 1; return a.map(x => (x - m) / s); },
        ema: (data, alpha) => { const out = [data[0]]; for (let i = 1; i < data.length; i++) { out.push(alpha * data[i] + (1 - alpha) * out[i - 1]); } return out; },
        rgbToHsv(r, g, b) { r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0, v = max; const d = max - min; s = max === 0 ? 0 : d / max; if (max !== min) { switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; case b: h = (r - g) / d + 4; break; } h /= 6; } return { h: h * 360, s: s, v: v }; },
        pearson(a, b) { const len = Math.min(a.length, b.length); if (len < 2) return 0; let meanA = this.mean(a), meanB = this.mean(b); let num = 0, denA = 0, denB = 0; for (let i = 0; i < len; i++) { const da = a[i] - meanA; const db = b[i] - meanB; num += da * db; denA += da * da; denB += db * db; } return num / (Math.sqrt(denA * denB) || 1); },
        xcorr(a, b, maxLag) { let maxCorrelation = -1; for (let lag = -maxLag; lag <= maxLag; lag++) { let sA, sB; if (lag >= 0) { sA = a.slice(lag); sB = b.slice(0, a.length - lag); } else { sA = a.slice(0, a.length + lag); sB = b.slice(-lag); } if(sA.length > 1) { const correlation = this.pearson(sA, sB); if (correlation > maxCorrelation) maxCorrelation = correlation; } } return maxCorrelation; }
    };

    async init() {
        window.addEventListener('resize', () => this.ui.setupRoi());
        await this.loadModel();
        this.startStream();
    }

    async loadModel() {
        this.ui.dom.loaderOverlay.querySelector('.loader-text').textContent = 'Загрузка TF.js...';
        await new Promise(resolve => {
            const interval = setInterval(() => {
                if (typeof tf !== 'undefined' && typeof mobilenet !== 'undefined') {
                    clearInterval(interval); resolve();
                }
            }, 100);
        });
        this.ui.dom.loaderOverlay.querySelector('.loader-text').textContent = 'Загрузка модели...';
        this.model = await mobilenet.load();
        this.modelReady = true;
        this.ui.onModelReady();
        this.onStatusUpdate("Модель загружена. Готов.", "success");
    }
    
    _setState(newState, operation = '') { this.state = newState; this.onStateChange(this.state, operation); }
    async startStream() { if (this.stream) return; try { this.onStatusUpdate("Запрос доступа...", 'info'); this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.currentFacingMode }, audio: false }); this.ui.dom.video.srcObject = this.stream; await new Promise((resolve, reject) => { this.ui.dom.video.onloadedmetadata = resolve; setTimeout(() => reject(new Error("Video metadata timeout")), 3000); }); this.ui.setupRoi(); this._setState(CONSTANTS.STATES.IDLE); if (this.modelReady) this.onStatusUpdate("Камера активна. Готов.", 'success'); } catch (err) { console.error("Camera Error:", err); this._setState(CONSTANTS.STATES.ERROR); let userMessage; switch(err.name) { case 'NotAllowedError': userMessage = 'Доступ к камере запрещён.'; break; case 'NotFoundError': userMessage = 'Камера не найдена.'; break; case 'NotReadableError': userMessage = 'Камера уже используется.'; break; default: userMessage = `Ошибка камеры: ${err.name}`; } this.onStatusUpdate(`Ошибка: ${userMessage}`, 'error'); } }
    stopStream() { if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; this.ui.dom.video.srcObject = null;} this._setState(CONSTANTS.STATES.BOOTING); }
    async switchCamera() { if (this.state !== CONSTANTS.STATES.IDLE) return; this.currentFacingMode = this.currentFacingMode === 'environment' ? 'user' : 'environment'; this.onStatusUpdate("Переключение...", 'info'); this.stopStream(); await this.startStream(); }
    _getROIImageData() { const v = this.ui.dom.video; const canvas = this.ui.dom.frameCanvas; if(!v.videoWidth || v.paused || v.ended) return null; canvas.width = v.videoWidth; canvas.height = v.videoHeight; this.ui.frameCtx.drawImage(v, 0, 0, canvas.width, canvas.height); const scaleX = canvas.width / v.clientWidth, scaleY = canvas.height / v.clientHeight; const roi = { x: this.ui.roiRect.x * scaleX, y: this.ui.roiRect.y * scaleY, w: this.ui.roiRect.w * scaleX, h: this.ui.roiRect.h * scaleY }; return this.ui.frameCtx.getImageData(roi.x, roi.y, roi.w, roi.h); }
    _getAverageROI_RGB() { const imgData = this._getROIImageData()?.data; if(!imgData) return null; let r = 0, g = 0, b = 0; const len = imgData.length / 4; for (let i = 0; i < imgData.length; i += 4) { r += imgData[i]; g += imgData[i+1]; b += imgData[i+2]; } return { r: r/len, g: g/len, b: b/len }; }
    _isSignalPresent() { const rgb = this._getAverageROI_RGB(); if (!rgb) return false; const hsv = this._math.rgbToHsv(rgb.r, rgb.g, rgb.b); const { HUE_SIGNAL_TARGET, HUE_TOLERANCE, SATURATION_MIN, VALUE_MIN } = CONSTANTS.CONFIG; if (hsv.s < SATURATION_MIN || hsv.v < VALUE_MIN) return false; const hueDist = Math.min(Math.abs(hsv.h - HUE_SIGNAL_TARGET), 360 - Math.abs(hsv.h - HUE_SIGNAL_TARGET)); return hueDist <= HUE_TOLERANCE; }
    async _checkStability() { this._setState(CONSTANTS.STATES.STABILIZING); this.onStatusUpdate("Анализ фона...", 'info'); const samples = []; const endTime = Date.now() + CONSTANTS.CONFIG.STABILITY_CHECK_DURATION_MS; while(Date.now() < endTime && this.state === CONSTANTS.STATES.STABILIZING) { samples.push(this._getAverageROI_RGB()?.r || 0); this.onProgressUpdate(100 * (1 - (endTime - Date.now()) / CONSTANTS.CONFIG.STABILITY_CHECK_DURATION_MS)); await new Promise(r => requestAnimationFrame(r)); } this.onProgressUpdate(0); if(this.state !== CONSTANTS.STATES.STABILIZING) throw new Error("Проверка отменена."); const stability = this._math.std(samples); if (stability > CONSTANTS.CONFIG.STABILITY_THRESHOLD) throw new Error(`Фон нестабилен (шум=${stability.toFixed(2)}).`); this.onStatusUpdate(`Фон стабилен (шум=${stability.toFixed(2)}).`, 'success'); }
    _captureSignal() { return new Promise((resolve, reject) => { const samples = []; let startT = null; const frame = (ts) => { if (this.state !== CONSTANTS.STATES.CAPTURING) return reject(new Error("Запись отменена")); if (!startT) startT = ts; const elapsed = ts - startT; try { const brightness = this._getAverageROI_RGB()?.r || 0; samples.push({ value: brightness, time: elapsed }); this.onProgressUpdate((elapsed / 3000) * 100); if (elapsed >= 3000) resolve(samples); else requestAnimationFrame(frame); } catch (e) { reject(e); } }; requestAnimationFrame(frame); }); }
    
    async _extractFeatures() {
        if (!this.modelReady) throw new Error("Модель еще не загружена!");
        const imgData = this._getROIImageData();
        if (!imgData) throw new Error("Нет данных с камеры");

        const tensor = tf.browser.fromPixels(imgData);
        const embedding = this.model.infer(tensor, true);
        const embeddingArray = await embedding.data();
        tensor.dispose(); embedding.dispose();

        const gray = new Uint8ClampedArray(imgData.width * imgData.height);
        let sum = 0, sumSq = 0;
        for (let i = 0; i < imgData.data.length; i += 4) {
            const b = 0.299 * imgData.data[i] + 0.587 * imgData.data[i+1] + 0.114 * imgData.data[i+2];
            gray[i / 4] = b; sum += b; sumSq += b * b;
        }
        const mean = sum / gray.length;
        const stdDev = Math.sqrt(sumSq / gray.length - mean * mean);
        const textureConfidence = Math.min(1.0, stdDev / 50.0);

        const threshold = 150;
        let centerX = 0, centerY = 0, totalPixels = 0;
        for (let y = 0; y < imgData.height; y++) {
            for (let x = 0; x < imgData.width; x++) {
                if (gray[y * imgData.width + x] > threshold) { centerX += x; centerY += y; totalPixels++; }
            }
        }
        const shapeConfidence = Math.min(1.0, totalPixels / (imgData.width * imgData.height * 0.1));

        const SHAPE_BINS = 16;
        const shapeDescriptor = new Array(SHAPE_BINS).fill(0);
        if (totalPixels > 0) {
            centerX /= totalPixels; centerY /= totalPixels;
            for (let y = 0; y < imgData.height; y++) {
                for (let x = 0; x < imgData.width; x++) {
                    if (gray[y * imgData.width + x] > threshold) {
                        const dx = x - centerX, dy = y - centerY;
                        const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 180;
                        const bin = Math.floor((angle / 360) * SHAPE_BINS) % SHAPE_BINS;
                        shapeDescriptor[bin]++;
                    }
                }
            }
            for (let i = 0; i < SHAPE_BINS; i++) shapeDescriptor[i] /= totalPixels;
        }

        return { embedding: embeddingArray, shape: shapeDescriptor, textureConfidence: textureConfidence, shapeConfidence: shapeConfidence };
    }

    async _executeWorkflow(isVerify) {
        const operation = isVerify ? 'verify' : 'enroll';
        const currentSignalType = this.ui.dom.signalType.value;
        if (this.state !== CONSTANTS.STATES.IDLE || (currentSignalType === CONSTANTS.MODES.STABLE && !this.modelReady)) { if (!this.modelReady) this.onStatusUpdate("Нейросеть еще грузится...", "error"); return; }
        const currentTemplates = this.templates[currentSignalType];
        if (isVerify && !currentTemplates.length) { this.onStatusUpdate(`Нет эталонов для режима "${currentSignalType}".`, 'error'); return; }

        try {
            await this._checkStability();
            this._setState(CONSTANTS.STATES.PROCESSING, operation);
            
            let processed;
            if (currentSignalType === CONSTANTS.MODES.STABLE) {
                processed = await this._extractFeatures();
            } else { // 'flicker'
                this._setState(CONSTANTS.STATES.CAPTURING, operation);
                const raw = await this._captureSignal();
                this._setState(CONSTANTS.STATES.PROCESSING, operation);
                const { ema, std, normalize } = this._math; if (raw.length < 2) throw new Error("Сигнал слишком короткий"); const duration = raw[raw.length - 1].time; const resampled = []; let s_idx = 0; for (let t = 0; t <= duration; t += CONSTANTS.CONFIG.SAMPLE_TARGET_MS) { while (s_idx < raw.length - 2 && raw[s_idx + 1].time < t) s_idx++; const a = raw[s_idx], b = raw[s_idx + 1]; const frac = (t - a.time) / (b.time - a.time || 1); resampled.push(a.value + (b.value - a.value) * frac); } const hp = resampled.map((v, i, a) => v - ema(a, 0.85)[i]); if (std(hp) < CONSTANTS.CONFIG.MIN_SIGNAL_STD) throw new Error(`Сигнал слишком слабый.`); const lp = ema(hp, 0.5); processed = normalize(lp);
            }

            if (isVerify) {
                if (currentSignalType === CONSTANTS.MODES.STABLE) {
                    let bestMatch = { similarity: 0, name: "Неизвестно" };

                    for (const templateObject of this.templates.stable) {
                        for (const templateFeature of templateObject.features) {
                            const embedSim = this._math.cosineSimilarity(processed.embedding, templateFeature.embedding);
                            const shapeSim = this._math.cosineSimilarity(processed.shape, templateFeature.shape);

                            const isTextured = processed.textureConfidence > CONSTANTS.CONFIG.TEXTURE_CONFIDENCE_THRESHOLD;
                            const isLightSource = processed.shapeConfidence > CONSTANTS.CONFIG.SHAPE_CONFIDENCE_THRESHOLD && !isTextured;

                            let final_similarity;
                            if (isTextured) {
                                final_similarity = embedSim * 0.9 + shapeSim * 0.1;
                            } else if (isLightSource) {
                                final_similarity = embedSim * 0.4 + shapeSim * 0.6;
                            } else {
                                final_similarity = embedSim;
                            }
                            
                            if (final_similarity > bestMatch.similarity) {
                                bestMatch = { similarity: final_similarity, name: templateObject.name };
                            }
                        }
                    }
                    const isMatch = bestMatch.similarity >= CONSTANTS.CONFIG.FUSION_SIMILARITY_THRESHOLD;
                    this.onStatusUpdate(`Объект: ${bestMatch.name}. Сходство=${bestMatch.similarity.toFixed(3)} → ${isMatch ? 'СОВПАДАЕТ' : 'НЕ СОВПАДАЕТ'}`, isMatch ? 'success' : 'error');
                
                } else { // 'flicker'
                    let bestMatch = { similarity: 0, dtw: Infinity, idx: -1 };
                     for (let i = 0; i < currentTemplates.length; i++) {
                        const similarity = this._math.xcorr(processed, currentTemplates[i], CONSTANTS.CONFIG.XCORR_MAX_LAG);
                        const dtw = await this.worker.exec('dtw', { a: processed, b: currentTemplates[i] });
                        if (similarity > bestMatch.similarity || (similarity === bestMatch.similarity && dtw < bestMatch.dtw)) {
                            bestMatch = { similarity, dtw, idx: i };
                        }
                    }
                    const isMatch = bestMatch.similarity > CONSTANTS.CONFIG.FLICKER_CORR_THRESHOLD && bestMatch.dtw < CONSTANTS.CONFIG.FLICKER_DTW_THRESHOLD;
                    this.onStatusUpdate(`Эталон #${bestMatch.idx + 1}: XCorr=${bestMatch.similarity.toFixed(2)}, DTW=${bestMatch.dtw.toFixed(2)} → ${isMatch ? 'СОВПАДАЕТ' : 'НЕ СОВПАДАЕТ'}`, isMatch ? 'success' : 'error');
                }
            } else { // enroll
                if (currentSignalType === CONSTANTS.MODES.STABLE) {
                    let targetObject;
                    if (this.templates.stable.length === 0) {
                        targetObject = { name: `Объект 1`, features: [] };
                        this.templates.stable.push(targetObject);
                    } else {
                        targetObject = this.templates.stable[this.templates.stable.length - 1];
                    }
                    targetObject.features.push(processed);
                    this.onStatusUpdate(`Эталон #${targetObject.features.length} для "${targetObject.name}" сохранён.`, 'success');
                } else { // 'flicker'
                    this.templates.flicker.push(processed);
                    this.onStatusUpdate(`Эталон #${this.templates.flicker.length} (flicker) сохранён.`, 'success');
                }
            }
        } catch (err) { this.onStatusUpdate(err.message, 'error'); } finally { this._setState(CONSTANTS.STATES.IDLE); }
    }
    
    async _receiveDataWorkflow() { if (this.isReceiving) { this.isReceiving = false; if (this.abortController) this.abortController.abort(); return; } this.isReceiving = true; this.abortController = new AbortController(); this._setState(CONSTANTS.STATES.CAPTURING, 'data'); const receiverFSM = { state: 'SYNCING', transitionBuffer: [], lastSignalState: null, receivedBits: '', totalPacketBits: -1, _decodeManchesterBuffer() { let decodedBits = ''; for (let i = 0; i < this.transitionBuffer.length - 1; i += 2) { const first = this.transitionBuffer[i].state; const second = this.transitionBuffer[i+1].state; if (!first && second) { decodedBits += '0'; } else if (first && !second) { decodedBits += '1'; } else { i--; } } this.transitionBuffer.splice(0, Math.floor(this.transitionBuffer.length / 2) * 2); return decodedBits; }, processFrame(engine) { if (engine.abortController.signal.aborted) { engine.onStatusUpdate("Прием отменен.", 'info'); return 'DONE'; } const currentSignalState = engine._isSignalPresent(); if (this.lastSignalState === null) { this.lastSignalState = currentSignalState; return 'CONTINUE'; } if (currentSignalState !== this.lastSignalState) { this.transitionBuffer.push({ state: this.lastSignalState }); this.lastSignalState = currentSignalState; if (this.state === 'SYNCING') { if (this.transitionBuffer.length >= 16) { const syncBits = this._decodeManchesterBuffer(); const expectedSync = CONSTANTS.MANCHESTER.START_SEQUENCE.join('').slice(0, syncBits.length); if (syncBits.startsWith(expectedSync)) { if(syncBits === CONSTANTS.MANCHESTER.START_SEQUENCE.join('')) { this.state = 'CAPTURING'; this.receivedBits = ''; this.transitionBuffer = []; engine.onStatusUpdate('Синхронизация! Прием данных...', 'success'); } } else { this.transitionBuffer.shift(); } } } else if (this.state === 'CAPTURING') { if (this.transitionBuffer.length >= 2) { const newBits = this._decodeManchesterBuffer(); this.receivedBits += newBits; if (this.totalPacketBits === -1 && this.receivedBits.length >= 8) { const lenByte = parseInt(this.receivedBits.slice(0, 8), 2); this.totalPacketBits = 8 + (lenByte * 8) + 8; engine.onStatusUpdate(`Длина пакета: ${lenByte} байт.`, 'info'); } if (this.totalPacketBits !== -1) { engine.onProgressUpdate((this.receivedBits.length / this.totalPacketBits) * 100); if (this.receivedBits.length >= this.totalPacketBits) return 'DONE'; } } } } return 'CONTINUE'; } }; const frameProcessor = () => { const status = receiverFSM.processFrame(this); if (status === 'CONTINUE' && !this.abortController.signal.aborted) { requestAnimationFrame(frameProcessor); } else if (status === 'DONE') { this.isReceiving = false; this._processPacket(receiverFSM.receivedBits); } }; this.onStatusUpdate('Ожидание синхронизации...', 'info'); requestAnimationFrame(frameProcessor); }
    async _processPacket(bitStream) { this._setState(CONSTANTS.STATES.PROCESSING); try { const text = await this.worker.exec('processPacket', bitStream); this.onStatusUpdate(`ПОЛУЧЕНО: "${text}"`, 'success'); } catch (e) { this.onStatusUpdate(`Ошибка: ${e.message}`, 'error'); } finally { this._setState(CONSTANTS.STATES.IDLE); } }
}

class Transmitter {
    constructor(ui, math) { this.ui = ui; this.math = math; this.isTransmitting = false; this.abortController = null; }
    async _setSignal(state, duration) { if (this.abortController?.signal.aborted) throw new Error("Передача отменена"); this.ui.dom.transmitter.style.backgroundColor = state ? CONSTANTS.MANCHESTER.COLOR_MAP.SIGNAL : CONSTANTS.MANCHESTER.COLOR_MAP.NO_SIGNAL; await new Promise(r => setTimeout(r, duration)); }
    async transmit() { if (this.isTransmitting) { if (this.abortController) this.abortController.abort(); return; } this.isTransmitting = true; this.abortController = new AbortController(); const sendBtn = this.ui.dom.sendBtn; sendBtn.textContent = 'Stop'; try { const text = this.ui.dom.dataToSend.value; const payloadBytes = new TextEncoder().encode(text); if (payloadBytes.length > 255) throw new Error("Сообщение слишком длинное!"); const lengthByte = payloadBytes.length; const dataWithLen = new Uint8Array([lengthByte, ...payloadBytes]); const crcByte = this._math.crc8(dataWithLen); let bitStream = ''; bitStream += lengthByte.toString(2).padStart(8, '0'); payloadBytes.forEach(b => bitStream += b.toString(2).padStart(8, '0')); bitStream += crcByte.toString(2).padStart(8, '0'); const fullSequence = [...CONSTANTS.MANCHESTER.START_SEQUENCE, ...bitStream.split('')]; const halfBitDuration = CONSTANTS.CONFIG.TRANSMIT_BIT_DURATION_MS / 2; this.ui.setStatus(`Передача ${payloadBytes.length} байт...`, 'info'); for (let i = 0; i < fullSequence.length; i++) { const bit = fullSequence[i]; if (bit === '1') { await this._setSignal(true, halfBitDuration); await this._setSignal(false, halfBitDuration); } else { await this._setSignal(false, halfBitDuration); await this._setSignal(true, halfBitDuration); } this.ui.setProgress(((i + 1) / fullSequence.length) * 100); } this.ui.setStatus('Передача завершена!', 'success'); } catch(e) { if (e.message !== "Передача отменена") this.ui.setStatus(`Ошибка: ${e.message}`, 'error'); else this.ui.setStatus('Передача остановлена.', 'info'); } finally { this.isTransmitting = false; this.abortController = null; sendBtn.textContent = 'Send'; this.ui.dom.transmitter.style.backgroundColor = '#000'; this.ui.setProgress(0); } }
}

// --- ТОЧКА ВХОДА ---
const ui = new UIController();
const workerService = new WorkerService(workerScript);
window.engine = new LightprintEngine(ui, workerService);
const transmitter = new Transmitter(ui, window.engine._math);

ui.init();
window.engine.init(); 

window.engine.onStateChange = (state, op) => ui.updateState(state, op);
window.engine.onStatusUpdate = (text, type) => ui.setStatus(text, type);
window.engine.onProgressUpdate = (p) => ui.setProgress(p);
window.engine.onPlotReady = (data, title) => ui.plotSignal(data, title);

ui.dom.roleSwitcher.addEventListener('change', (e) => ui.switchRole(e.target.value, window.engine));
ui.dom.signalType.addEventListener('change', () => ui.updateUIMode());
ui.dom.receiveBtn.addEventListener('click', () => window.engine._receiveDataWorkflow());
ui.dom.sendBtn.addEventListener('click', () => transmitter.transmit());
ui.dom.switchCamBtn.addEventListener('click', () => window.engine.switchCamera());
ui.dom.clearBtn.addEventListener('click', () => { 
    const type = ui.dom.signalType.value;
    if(type === CONSTANTS.MODES.STABLE) {
         if (confirm('Очистить все эталоны для стабильного режима?')) {
            window.engine.templates.stable = [];
            ui.clearPlots();
            ui.setStatus(`Все стабильные эталоны очищены.`, 'info');
         }
    } else if (type === CONSTANTS.MODES.FLICKER) {
        window.engine.templates.flicker = [];
        ui.clearPlots();
        ui.setStatus(`Эталоны для мерцания очищены.`, 'info');
    }
});
ui.dom.enrollBtn.addEventListener('click', () => window.engine._executeWorkflow(false));
ui.dom.verifyBtn.addEventListener('click', () => window.engine._executeWorkflow(true));

ui.switchRole(CONSTANTS.ROLES.RECEIVER, window.engine);
ui.updateUIMode();

})(); // Конец IIFE
