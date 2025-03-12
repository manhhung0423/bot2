/********************************************
 *  BOT PHÂN TÍCH CRYPTO VỚI TÍNH NĂNG LƯU TRỮ SQL VÀ GIẢ LẬP
 *  (Sử dụng LSTM với WINDOW_SIZE, dynamic training control và lời khuyên đòn bẩy)
 ********************************************/

const TelegramBot = require('node-telegram-bot-api');
const { RSI, SMA, MACD, BollingerBands, ADX, ATR, Stochastic, OBV, IchimokuCloud } = require('technicalindicators');
const tf = require('@tensorflow/tfjs');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');

const wsStreams = {}; // Lưu WebSocket đang mở
const activeSubscriptions = {}; // Lưu số người theo dõi mỗi cặp
const cacheKlines = new Map(); // Lưu dữ liệu nến
const lastUpdateTime = {}; // Lưu thời gian cập nhật mới nhất từ WebSocket
const wsReconnectAttempts = {}; // Đếm số lần thử lại WebSocket
const apiRetryCounter = {}; // Đếm số lần thử lại API
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const BINANCE_API = 'https://api.binance.com/api/v3';

// 🟢 Đăng ký WebSocket Binance
function subscribeBinance(symbol, pair, timeframe) {
    const streamKey = `${symbol.toLowerCase()}_${pair.toLowerCase()}_${timeframe}`;
    if (wsStreams[streamKey]) {
        activeSubscriptions[streamKey] = (activeSubscriptions[streamKey] || 0) + 1;
        console.log(`📡 WebSocket ${symbol}/${pair}/${timeframe} đang hoạt động. Người theo dõi: ${activeSubscriptions[streamKey]}`);
        return;
    }

    if (!wsReconnectAttempts[streamKey]) wsReconnectAttempts[streamKey] = 0;
    if (wsReconnectAttempts[streamKey] >= 5) {
        console.error(`🚨 WebSocket ${symbol}/${pair}/${timeframe} bị lỗi quá nhiều lần, dừng kết nối.`);
        return;
    }

    const wsUrl = `${BINANCE_WS_URL}/${symbol.toLowerCase()}${pair.toLowerCase()}@kline_${timeframe}`;
    console.log(`🔗 Kết nối WebSocket Binance: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    wsStreams[streamKey] = ws;

    ws.on('open', () => {
        console.log(`✅ Kết nối WebSocket thành công: ${symbol}/${pair}/${timeframe}`);
        activeSubscriptions[streamKey] = 1;
        wsReconnectAttempts[streamKey] = 0;
    });

    ws.on('message', (data) => {
        try {
            const json = JSON.parse(data);
            if (!json.k) return;

            const kline = json.k;
            if (!kline.t || !kline.o || !kline.h || !kline.l || !kline.c || !kline.v) return;

            const newCandle = {
                timestamp: kline.t,
                open: parseFloat(kline.o),
                high: parseFloat(kline.h),
                low: parseFloat(kline.l),
                close: parseFloat(kline.c),
                volume: parseFloat(kline.v)
            };

            const cacheKey = `${symbol}_${pair}_${timeframe}`;
            if (!cacheKlines.has(cacheKey)) cacheKlines.set(cacheKey, []);
            const candles = cacheKlines.get(cacheKey);
            candles.push(newCandle);
            if (candles.length > 2000) candles.shift();

            lastUpdateTime[cacheKey] = Date.now();
            console.log(`📊 [REAL-TIME] ${symbol}/${pair} (${timeframe}) - Close: ${newCandle.close}, Volume: ${newCandle.volume}, Tổng nến: ${candles.length}`);
        } catch (error) {
            console.error(`❌ Lỗi xử lý dữ liệu WebSocket: ${error.message}`);
        }
    });

    ws.on('error', (err) => {
        console.error(`🚨 Lỗi WebSocket ${symbol}/${pair}/${timeframe}: ${err.message}`);
        setTimeout(() => subscribeBinance(symbol, pair, timeframe), 5000);
    });

    ws.on('close', () => {
        console.log(`❌ WebSocket ${symbol}/${pair}/${timeframe} bị đóng.`);
        delete wsStreams[streamKey];
        delete activeSubscriptions[streamKey];
        wsReconnectAttempts[streamKey]++;
        if (wsReconnectAttempts[streamKey] < 5) {
            console.log(`🔄 Thử kết nối lại (lần ${wsReconnectAttempts[streamKey]}/5)...`);
            setTimeout(() => subscribeBinance(symbol, pair, timeframe), 5000);
        }
    });
}

// 🔴 Hủy WebSocket
function unsubscribeBinance(symbol, pair, timeframe) {
    const streamKey = `${symbol.toLowerCase()}_${pair.toLowerCase()}_${timeframe}`;
    if (!wsStreams[streamKey]) return;

    activeSubscriptions[streamKey] -= 1;
    console.log(`📉 Người theo dõi ${symbol}/${pair}/${timeframe} giảm còn: ${activeSubscriptions[streamKey]}`);
    if (activeSubscriptions[streamKey] <= 0) {
        console.log(`❌ Đóng WebSocket ${symbol}/${pair}/${timeframe} do không còn người theo dõi.`);
        wsStreams[streamKey].close();
        delete wsStreams[streamKey];
        delete activeSubscriptions[streamKey];
    }
}

// 🟢 Lấy dữ liệu API Binance nếu WebSocket lỗi
async function fetchKlines(symbol, pair, timeframe, limit = 500, retries = 3, delay = 5000) {
    const cacheKey = `${symbol}_${pair}_${timeframe}`;
    console.log(`🔍 Lấy dữ liệu API Binance cho ${symbol}/${pair} (${timeframe})`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(`${BINANCE_API}/klines`, {
                params: { symbol: `${symbol.toUpperCase()}${pair.toUpperCase()}`, interval: timeframe, limit },
                timeout: 10000,
            });

            if (!response.data || !Array.isArray(response.data)) throw new Error('Dữ liệu API không hợp lệ');
            const klines = response.data.map(d => ({
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5])
            }));

            console.log(`✅ API Binance trả về ${klines.length} nến mới.`);
            let currentData = cacheKlines.get(cacheKey) || [];
            currentData = [...klines, ...currentData.filter(c => c.timestamp > klines[klines.length - 1].timestamp)]; // Gộp dữ liệu API và WebSocket
            if (currentData.length > 2000) currentData = currentData.slice(-2000); // Giới hạn 2000 nến
            cacheKlines.set(cacheKey, currentData);
            lastUpdateTime[cacheKey] = Date.now();
            return currentData;
        } catch (error) {
            console.error(`❌ Lỗi API Binance (${symbol}/${pair}, attempt ${attempt}/${retries}): ${error.message}`);
            if (attempt < retries) await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return cacheKlines.get(cacheKey) || [];
}

// Kiểm tra WebSocket và fallback sang API
setInterval(async () => {
    Object.keys(lastUpdateTime).forEach(async (cacheKey) => {
        const lastTime = lastUpdateTime[cacheKey] || 0;
        if (Date.now() - lastTime > 5000) {
            apiRetryCounter[cacheKey] = (apiRetryCounter[cacheKey] || 0) + 1;
            if (apiRetryCounter[cacheKey] <= 3) {
                console.warn(`⚠️ Không có dữ liệu từ WebSocket (${cacheKey}) trong 5 giây. Fallback sang API.`);
                const [symbol, pair, timeframe] = cacheKey.split("_");
                const data = await fetchKlines(symbol, pair, timeframe, 10);
                if (data.length > 0) apiRetryCounter[cacheKey] = 0;
            } else {
                console.error(`🚨 API Binance bị gọi quá nhiều lần cho ${cacheKey}. Tạm dừng fallback.`);
            }
        } else {
            apiRetryCounter[cacheKey] = 0;
        }
    });
}, 5000);

// Tự động kết nối WebSocket
function autoSubscribe() {
    console.log("🔄 Đang khởi động bot và kết nối WebSocket...");
    const defaultPair = { symbol: 'ada', pair: 'usdt', timeframe: '15m' };
    subscribeBinance(defaultPair.symbol, defaultPair.pair, defaultPair.timeframe);
    console.log("✅ WebSocket đã được khởi tạo cho cặp mặc định ADA/USDT (15m).");
}

autoSubscribe();

// CẤU HÌNH BOT
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '7644381153:AAGtd8uhtdPFbDqlpA9NAUSsIsePXQiO36g';
let adminChatId = null;

const timeframes = {
    '1m': '1 phút', '3m': '3 phút', '5m': '5 phút', '15m': '15 phút', '30m': '30 phút',
    '1h': '1 giờ', '2h': '2 giờ', '4h': '4 giờ', '6h': '6 giờ', '8h': '8 giờ', '12h': '12 giờ',
    '1d': '1 ngày', '3d': '3 ngày', '1w': '1 tuần', '1M': '1 tháng'
};

function normalizeTimeframe(tfInput) {
    const mapping = {
        'm1': '1m', '1m': '1m', 'm3': '3m', '3m': '3m', 'm5': '5m', '5m': '5m', 'm15': '15m', '15m': '15m',
        'm30': '30m', '30m': '30m', 'h1': '1h', '1h': '1h', 'h2': '2h', '2h': '2h', 'h4': '4h', '4h': '4h',
        'h6': '6h', '6h': '6h', 'h8': '8h', '8h': '8h', 'h12': '12h', '12h': '12h', 'd1': '1d', '1d': '1d',
        'd3': '3d', '3d': '3d', 'w1': '1w', '1w': '1w', 'M1': '1M', '1M': '1M'
    };
    return mapping[tfInput] || null;
}

const bot = new TelegramBot(TOKEN, { polling: true });
const BOT_DB_PATH = path.join(__dirname, 'bot.db');
const BOT_LOG_PATH = path.join(__dirname, 'bot.log');
const MODEL_DIR = path.join(__dirname, 'model');

bot.on('message', (msg) => {
    if (!adminChatId) {
        adminChatId = msg.chat.id;
        console.log(`Admin chatId đã được thiết lập: ${adminChatId}`);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Admin chatId: ${adminChatId}\n`);
    }
});

// SQLITE
const db = new sqlite3.Database(BOT_DB_PATH, (err) => {
    if (err) {
        console.error('SQLite Error:', err.message);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi kết nối SQLite: ${err.message}\n`);
    } else {
        console.log('✅ Kết nối SQLite thành công.');
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - ✅ Kết nối SQLite thành công.\n`);
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS watch_configs (chatId INTEGER NOT NULL, symbol TEXT NOT NULL, pair TEXT NOT NULL, timeframe TEXT NOT NULL, PRIMARY KEY (chatId, symbol, pair, timeframe))`);
    db.run(`CREATE TABLE IF NOT EXISTS signal_history (id INTEGER PRIMARY KEY AUTOINCREMENT, chatId INTEGER NOT NULL, symbol TEXT NOT NULL, pair TEXT NOT NULL, timeframe TEXT NOT NULL, signal TEXT NOT NULL, confidence INTEGER NOT NULL, timestamp INTEGER NOT NULL, entry_price REAL NOT NULL, exit_price REAL, profit REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_settings (chatId INTEGER PRIMARY KEY, showTechnicalIndicators INTEGER DEFAULT 0)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_signal_history_chatId ON signal_history (chatId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_signal_history_timestamp ON signal_history (timestamp)`);
});

function addWatchConfig(chatId, symbol, pair, timeframe, callback) {
    db.run(`INSERT OR REPLACE INTO watch_configs (chatId, symbol, pair, timeframe) VALUES (?, ?, ?, ?)`, [chatId, symbol, pair, timeframe], callback);
}

function deleteWatchConfig(chatId, symbol, pair, timeframe, callback) {
    db.run(`DELETE FROM watch_configs WHERE chatId = ? AND symbol = ? AND pair = ? AND timeframe = ?`, [chatId, symbol, pair, timeframe], callback);
}

function loadWatchConfigs() {
    return new Promise((resolve, reject) => {
        db.all("SELECT chatId, symbol, pair, timeframe FROM watch_configs", [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getUserSettings(chatId) {
    return new Promise((resolve) => {
        db.get(`SELECT showTechnicalIndicators FROM user_settings WHERE chatId = ?`, [chatId], (err, row) => {
            resolve(row ? row.showTechnicalIndicators : 0);
        });
    });
}

function setUserSettings(chatId, showTechnicalIndicators) {
    db.run(`INSERT OR REPLACE INTO user_settings (chatId, showTechnicalIndicators) VALUES (?, ?)`, [chatId, showTechnicalIndicators]);
}

// LSTM CONFIG
let currentConfig = { windowSize: 5, units: 32, epochs: 10 };
let bestConfig = { ...currentConfig };
let bestAccuracy = 0;
let recentAccuracies = [];
let lastAccuracy = 0;
let model;

function createModel(windowSize, units) {
    const model = tf.sequential();
    model.add(tf.layers.lstm({ units, inputShape: [windowSize, 22], returnSequences: true, kernelInitializer: 'glorotUniform' }));
    model.add(tf.layers.dense({ units: Math.max(units / 2, 16), activation: 'relu' }));
    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dense({ units: 10, activation: 'relu' }));
    model.add(tf.layers.dense({ units: 3, activation: 'softmax' }));
    model.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
    return model;
}

async function initializeModel() {
    model = createModel(currentConfig.windowSize, currentConfig.units);
    console.log('✅ LSTM model đã được khởi tạo');
}

async function trainModelData(data, symbol, pair, timeframe) {
    try {
        const inputs = [];
        const outputs = [];
        const minDataLength = currentConfig.windowSize + 5; // Đủ cho windowSize và dự đoán 5 nến
        if (!data || data.length < minDataLength) {
            console.warn(`⚠️ Dữ liệu không đủ (${data?.length || 0}/${minDataLength}) để huấn luyện ${symbol}/${pair} (${timeframe}).`);
            return;
        }

        for (let i = currentConfig.windowSize; i < data.length - 5; i++) {
            const windowFeatures = [];
            const futureSignals = [];
            const startIdx = Math.max(0, i - currentConfig.windowSize);
            const windowData = data.slice(0, i + 1); // Dữ liệu từ đầu đến i
            if (windowData.length < currentConfig.windowSize) continue;

            for (let j = startIdx; j < i; j++) {
                const features = computeFeature(windowData, j, symbol, pair, timeframe);
                if (!features) {
                    console.warn(`⚠️ Bỏ qua do lỗi tính đặc trưng tại index ${j}`);
                    continue;
                }
                windowFeatures.push(features);
            }

            for (let k = 0; k < 5; k++) {
                if (i + k + 1 < data.length) {
                    const currentPrice = data[i + k].close;
                    const futurePrice = data[i + k + 1].close;
                    const priceChange = (futurePrice - currentPrice) / currentPrice * 100;
                    let trueSignal = [0, 0, 1]; // WAIT
                    if (priceChange > 0.5) trueSignal = [1, 0, 0]; // LONG
                    else if (priceChange < -0.5) trueSignal = [0, 1, 0]; // SHORT
                    futureSignals.push(trueSignal);
                }
            }
            while (futureSignals.length < 5) futureSignals.push([0, 0, 1]);

            if (windowFeatures.length === currentConfig.windowSize) {
                inputs.push(windowFeatures);
                outputs.push(futureSignals);
            }
        }

        if (inputs.length === 0) {
            console.warn(`⚠️ Không có dữ liệu hợp lệ để huấn luyện ${symbol}/${pair} (${timeframe}).`);
            return;
        }

        const xs = tf.tensor3d(inputs, [inputs.length, currentConfig.windowSize, 22]);
        const ys = tf.tensor3d(outputs, [outputs.length, 5, 3]);
        await model.fit(xs, ys, { epochs: currentConfig.epochs, batchSize: 32, shuffle: true });
        console.log(`✅ Mô hình đã được huấn luyện với ${symbol}/${pair} (${timeframe}).`);
        xs.dispose();
        ys.dispose();
    } catch (error) {
        console.error(`❌ Lỗi huấn luyện mô hình với ${symbol}/${pair} (${timeframe}): ${error.message}`);
    }
}

async function trainModelWithMultiplePairs() {
    const pairs = [{ symbol: 'ADA', pair: 'USDT', timeframe: '15m' }];
    for (const { symbol, pair, timeframe } of pairs) {
        const cacheKey = `${symbol}_${pair}_${timeframe}`;
        let data = cacheKlines.get(cacheKey) || [];
        const minCandlesNeeded = currentConfig.windowSize + 5;

        if (!data || data.length < minCandlesNeeded) {
            console.warn(`⚠️ Không đủ dữ liệu (${data.length}/${minCandlesNeeded}) cho ${symbol}/${pair} (${timeframe}).`);
            subscribeBinance(symbol, pair, timeframe);
            const maxWaitTime = 10000;
            const startTime = Date.now();
            while (Date.now() - startTime < maxWaitTime) {
                data = cacheKlines.get(cacheKey) || [];
                if (data.length >= minCandlesNeeded) break;
                console.log(`⏳ Đợi dữ liệu WebSocket: ${data.length}/${minCandlesNeeded}`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (data.length < minCandlesNeeded) {
                data = await fetchKlines(symbol, pair, timeframe, 200);
                if (!data || data.length < minCandlesNeeded) {
                    console.error(`❌ Không thể lấy đủ dữ liệu ${symbol}/${pair} (${timeframe}).`);
                    continue;
                }
            }
        }
        await trainModelData(data, symbol, pair, timeframe);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function optimizeModel() {
    if (recentAccuracies.length < 50) return;
    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    if (avgAcc > 0.7) return;

    console.log('⚙️ Bắt đầu tối ưu hóa mô hình...');
    const configsToTest = [
        { windowSize: 5, units: 32, epochs: 10 },
        { windowSize: 10, units: 64, epochs: 15 },
        { windowSize: 15, units: 128, epochs: 20 }
    ];
    const symbol = 'ADA', pair = 'USDT', timeframe = '15m';
    const cacheKey = `${symbol}_${pair}_${timeframe}`;
    let historicalData = cacheKlines.has(cacheKey) ? cacheKlines.get(cacheKey) : [];
    const minCandlesNeeded = 200;

    if (!historicalData || historicalData.length < minCandlesNeeded) {
        subscribeBinance(symbol, pair, timeframe);
        const maxWaitTime = 10000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitTime) {
            historicalData = cacheKlines.get(cacheKey) || [];
            if (historicalData.length >= minCandlesNeeded) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (historicalData.length < minCandlesNeeded) {
            historicalData = await fetchKlines(symbol, pair, timeframe, minCandlesNeeded);
            if (!historicalData || historicalData.length < minCandlesNeeded) return;
        }
    }

    for (const config of configsToTest) {
        currentConfig = { ...config };
        recentAccuracies = [];
        for (let i = currentConfig.windowSize; i < Math.min(historicalData.length, 50 + currentConfig.windowSize); i++) {
            await selfEvaluateAndTrain(historicalData.slice(0, i), i, historicalData, symbol, pair, timeframe);
        }
        const newAvgAcc = recentAccuracies.length > 0 ? recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length : 0;
        if (newAvgAcc > bestAccuracy) {
            bestAccuracy = newAvgAcc;
            bestConfig = { ...config };
        }
    }
    if (bestConfig) Object.assign(currentConfig, bestConfig);
}

// CHỈ BÁO KỸ THUẬT
function computeRSI(close, period = 14) {
    if (!Array.isArray(close) || close.length < period || close.some(v => typeof v !== 'number' || isNaN(v))) {
        console.warn(`⚠️ Dữ liệu không đủ hoặc không hợp lệ để tính RSI (length: ${close?.length || 0}, period: ${period})`);
        return null;
    }
    const result = RSI.calculate({ values: close, period });
    return result.length > 0 ? result[result.length - 1] : null;
}
function computeMA(close, period = 20) {
    if (!Array.isArray(close) || close.length < period || close.some(v => typeof v !== 'number' || isNaN(v))) {
        console.warn(`⚠️ Dữ liệu không đủ hoặc không hợp lệ để tính MA (length: ${close?.length || 0}, period: ${period})`);
        return null;
    }
    const ma = SMA.calculate({ values: close, period });
    return ma.length > 0 ? ma[ma.length - 1] : null;
}

function computeMACD(close) {
    const minLength = 26 + 9 - 1; // slowPeriod + signalPeriod - 1
    if (!Array.isArray(close) || close.length < minLength || close.some(v => typeof v !== 'number' || isNaN(v))) {
        console.warn(`⚠️ Dữ liệu không đủ hoặc không hợp lệ để tính MACD (length: ${close?.length || 0}, min required: ${minLength})`);
        return null;
    }
    const result = MACD.calculate({ values: close, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    return result.length > 0 ? [
        result[result.length - 1].MACD || 0,
        result[result.length - 1].signal || 0,
        result[result.length - 1].histogram || 0
    ] : null;
}

function computeBollingerBands(close, period = 20, stdDev = 2) {
    if (!Array.isArray(close) || close.length < period) return [0, 0, 0];
    const result = BollingerBands.calculate({ values: close, period, stdDev });
    return result.length > 0 ? [result[result.length - 1].upper, result[result.length - 1].middle, result[result.length - 1].lower] : [0, 0, 0];
}

function computeADX(data, period = 14) {
    if (!Array.isArray(data) || data.length < period) return 0;
    const result = ADX.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), period });
    return result.length > 0 ? result[result.length - 1].adx || 0 : 0;
}

function computeATR(data, period = 14) {
    if (!Array.isArray(data) || data.length < period) return 0;
    const result = ATR.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), period });
    return result.length > 0 ? result[result.length - 1] || 0 : 0;
}

function computeStochastic(data, kPeriod = 14) {
    if (!Array.isArray(data) || data.length < kPeriod) return 50;
    const result = Stochastic.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), period: kPeriod, signalPeriod: 3, smooth: 3 });
    return result.length > 0 ? result[result.length - 1].k : 50;
}

function computeVWAP(data) {
    if (!Array.isArray(data) || data.length === 0) return 0;
    let totalVolume = 0, totalPriceVolume = 0;
    for (const d of data) {
        const typicalPrice = (d.high + d.low + d.close) / 3;
        totalPriceVolume += typicalPrice * d.volume;
        totalVolume += d.volume;
    }
    return totalVolume > 0 ? totalPriceVolume / totalVolume : 0;
}

function computeOBV(data) {
    if (!Array.isArray(data) || data.length === 0) return 0;
    const result = OBV.calculate({ close: data.map(d => d.close), volume: data.map(d => d.volume) });
    return result.length > 0 ? result[result.length - 1] : 0;
}

function computeIchimoku(data) {
    if (!Array.isArray(data) || data.length < 52) return null;
    const result = IchimokuCloud.calculate({ high: data.map(d => d.high), low: data.map(d => d.low), close: data.map(d => d.close), conversionPeriod: 9, basePeriod: 26, spanPeriod: 52, displacement: 26 });
    return result.length > 0 ? result[result.length - 1] : null;
}

function computeFibonacciLevels(data) {
    if (!Array.isArray(data) || data.length === 0) return { 0.236: 0, 0.382: 0, 0.5: 0, 0.618: 0, 0.786: 0 };
    const highs = data.map(d => d.high), lows = data.map(d => d.low);
    const maxPrice = Math.max(...highs), minPrice = Math.min(...lows);
    const diff = maxPrice - minPrice;
    return {
        0.236: maxPrice - diff * 0.236,
        0.382: maxPrice - diff * 0.382,
        0.5: maxPrice - diff * 0.5,
        0.618: maxPrice - diff * 0.618,
        0.786: maxPrice - diff * 0.786
    };
}

function computeSupportResistance(data) {
    if (!Array.isArray(data) || data.length === 0) return { support: 0, resistance: 0 };
    const highs = data.map(d => d.high), lows = data.map(d => d.low);
    return { support: Math.min(...lows), resistance: Math.max(...highs) };
}

// ONE-HOT ENCODING
const symbolMap = new Map(), pairMap = new Map(), timeframeMap = new Map();
const EMBEDDING_SIZE = 3;

function getEmbedding(value, map) {
    if (!map.has(value)) map.set(value, Array.from({ length: EMBEDDING_SIZE }, () => Math.random()));
    return map.get(value);
}

function computeFeature(data, j, symbol, pair, timeframe) {
    if (!data || !data[j] || data.length < currentConfig.windowSize) {
        console.error(`⚠️ computeFeature: Thiếu dữ liệu cho ${symbol}/${pair} (${timeframe}) tại index ${j}, length: ${data?.length || 0}, yêu cầu tối thiểu: ${currentConfig.windowSize}`);
        return null;
    }

    const subData = data.slice(0, j + 1);
    const close = subData.map(d => d.close);
    const volume = subData.map(d => d.volume);
    const maxClose = Math.max(...close) || 1;
    const safeDivide = (num, denom) => (denom !== 0 ? num / denom : 0);

    const rsi = close.length >= 14 ? computeRSI(close) || 50 : 50;
    const ma10 = close.length >= 10 ? computeMA(close, 10) || 0 : close[close.length - 1];
    const ma50 = close.length >= 50 ? computeMA(close, 50) || 0 : close[close.length - 1];
    const ema200 = close.length >= 200 ? computeMA(close, 200) || 0 : close[close.length - 1];
    const atr = subData.length >= 14 ? computeATR(subData) || 0.0001 : 0.0001;
    const adx = subData.length >= 14 ? computeADX(subData) || 0 : 0;
    const stochasticK = subData.length >= 14 ? computeStochastic(subData) || 50 : 50;
    const vwap = computeVWAP(subData) || close[close.length - 1];
    const obv = computeOBV(subData) || 0;
    const fibLevels = computeFibonacciLevels(subData) || { 0.618: close[close.length - 1] };
    const ichimoku = subData.length >= 52 ? computeIchimoku(subData) || { conversionLine: 0, baseLine: 0 } : { conversionLine: 0, baseLine: 0 };
    const histogram = close.length >= 34 ? computeMACD(close)?.[2] || 0 : 0;
    const middleBB = close.length >= 20 ? computeBollingerBands(close)?.[1] || 0 : close[close.length - 1];

    const volumeMA = volume.length >= 20 ? computeMA(volume, 20) || 0 : volume[volume.length - 1];
    const volumeSpike = volume[volume.length - 1] > volumeMA * 1.5 ? 1 : 0;

    const symbolEmbedding = getEmbedding(symbol, symbolMap);
    const pairEmbedding = getEmbedding(pair, pairMap);
    const timeframeEmbedding = getEmbedding(timeframe, timeframeMap);

    const features = [
        rsi / 100, adx / 100, safeDivide(histogram, maxClose), volumeSpike,
        safeDivide(ma10 - ma50, maxClose), safeDivide(close[close.length - 1] - middleBB, maxClose),
        stochasticK / 100, safeDivide(close[close.length - 1] - vwap, maxClose), obv / 1e6,
        safeDivide(ichimoku.conversionLine - ichimoku.baseLine, maxClose),
        safeDivide(close[close.length - 1] - fibLevels[0.618], maxClose),
        safeDivide(close[close.length - 1] - ema200, maxClose),
        safeDivide(close[close.length - 1] - atr, maxClose),
        ...symbolEmbedding, ...pairEmbedding, ...timeframeEmbedding
    ];

    return features.map(f => (isNaN(f) || f === undefined ? 0 : f));
}

async function getCryptoAnalysis(symbol, pair, timeframe, chatId) {
    const cacheKey = `${symbol}_${pair}_${timeframe}`;
    let df = cacheKlines.has(cacheKey) ? cacheKlines.get(cacheKey) : [];
    const minCandlesNeeded = 200;

    if (!df || df.length < minCandlesNeeded) {
        console.warn(`⚠️ Không đủ dữ liệu (${df.length}/${minCandlesNeeded}) trong cacheKlines cho ${symbol}/${pair} (${timeframe}).`);
        subscribeBinance(symbol, pair, timeframe);
        const maxWaitTime = 10000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitTime) {
            df = cacheKlines.get(cacheKey) || [];
            if (df.length >= minCandlesNeeded) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (df.length < minCandlesNeeded) {
            df = await fetchKlines(symbol, pair, timeframe, minCandlesNeeded);
            if (!df || df.length < minCandlesNeeded) {
                return { result: '❗ Không đủ dữ liệu để dự đoán', confidence: 0 };
            }
        }
    }

    const windowFeatures = [];
    for (let i = Math.max(0, df.length - currentConfig.windowSize); i < df.length; i++) {
        const features = computeFeature(df.slice(0, i + 1), i, symbol, pair, timeframe);
        if (!features) return { result: '❗ Lỗi tính toán chỉ báo kỹ thuật', confidence: 0 };
        windowFeatures.push(features);
    }

    const currentPrice = df[df.length - 1]?.close;
    if (typeof currentPrice !== 'number') {
        return { result: '❗ Lỗi giá hiện tại không xác định', confidence: 0 };
    }
    const closePrices = df.map(d => d.close);
    const volume = df.map(d => d.volume);
    const indicators = {
        atr: computeATR(df) || 0.0001,
        rsi: computeRSI(closePrices) || 50,
        adx: computeADX(df) || 0,
        macd: computeMACD(closePrices) || [0, 0, 0],
        bollinger: computeBollingerBands(closePrices) || [0, 0, 0],
        stochastic: computeStochastic(df) || 50,
        vwap: computeVWAP(df) || currentPrice,
        obv: computeOBV(df) || 0,
        ichimoku: computeIchimoku(df) || { spanA: currentPrice, spanB: currentPrice },
        fibLevels: computeFibonacciLevels(df) || { 0.618: currentPrice, 0.5: currentPrice },
        supportRes: computeSupportResistance(df) || { support: currentPrice - 0.01, resistance: currentPrice + 0.01 }
    };
    const volumeMA = computeMA(volume, 20);
    const volumeSpike = volume[volume.length - 1] > volumeMA * 1.5 ? 1 : 0;
    const input = tf.tensor3d([windowFeatures], [1, currentConfig.windowSize, 22]);
    const prediction = model.predict(input);
    const predictions = prediction.arraySync()[0];
    input.dispose();
    prediction.dispose();

    let longProb = 0, shortProb = 0, waitProb = 0;
    for (const [l, s, w] of predictions) {
        longProb += l;
        shortProb += s;
        waitProb += w;
    }
    longProb /= 5;
    shortProb /= 5;
    waitProb /= 5;

    let signalType = 'WAIT', signalText = '⚪️ ĐỢI - Chưa có tín hiệu', confidence = Math.round(Math.max(longProb, shortProb, waitProb) * 100);
    let entry = currentPrice, sl = 0, tp = 0;

// Xác định tín hiệu dựa trên AI và điều chỉnh theo chỉ báo
    if (longProb > shortProb && longProb > waitProb && longProb > 0.5) {
        signalType = 'LONG';
        signalText = '🟢 LONG - Mua';
        sl = Math.max(currentPrice - indicators.atr * (indicators.adx < 20 ? 1.0 : 1.5), indicators.supportRes.support);
        tp = Math.min(currentPrice + indicators.atr * (indicators.adx < 20 ? 1.5 : 2.0), indicators.supportRes.resistance);
    } else if (shortProb > longProb && shortProb > waitProb && shortProb > 0.5) {
        signalType = 'SHORT';
        signalText = '🔴 SHORT - Bán';
        sl = Math.min(currentPrice + indicators.atr * (indicators.adx < 20 ? 1.0 : 1.5), indicators.supportRes.resistance);
        tp = Math.max(currentPrice - indicators.atr * (indicators.adx < 20 ? 1.5 : 2.0), indicators.supportRes.support);
    }

    // Điều chỉnh độ tin cậy dựa trên chỉ báo
    let adjustedConfidence = confidence;
    if (indicators.adx < 20) adjustedConfidence = Math.min(adjustedConfidence, 60); // Xu hướng yếu
    if (indicators.rsi > 70 && signalType === 'LONG') adjustedConfidence *= 0.8; // Quá mua
    if (indicators.rsi < 30 && signalType === 'SHORT') adjustedConfidence *= 0.8; // Quá bán
    const showTechnicalIndicators = await getUserSettings(chatId);
    const details = [];
    if (showTechnicalIndicators) {
        details.push(`📈 RSI: ${indicators.rsi.toFixed(1)}`);
        details.push(`🎯 Stochastic %K: ${indicators.stochastic.toFixed(1)}`);
        details.push(`📊 VWAP: ${indicators.vwap.toFixed(4)}`);
        details.push(`📦 OBV: ${(indicators.obv / 1e6).toFixed(2)}M`);
        const isAboveCloud = indicators.ichimoku && currentPrice > Math.max(indicators.ichimoku.spanA, indicators.ichimoku.spanB);
        const isBelowCloud = indicators.ichimoku && currentPrice < Math.min(indicators.ichimoku.spanA, indicators.ichimoku.spanB);
        details.push(`☁️ Ichimoku: ${isAboveCloud ? 'Trên đám mây' : isBelowCloud ? 'Dưới đám mây' : 'Trong đám mây'}`);
        details.push(`📏 Fib Levels: 0.618: ${indicators.fibLevels[0.618]?.toFixed(4) || 'N/A'}, 0.5: ${indicators.fibLevels[0.5]?.toFixed(4) || 'N/A'}, 0.382: ${indicators.fibLevels[0.382]?.toFixed(4) || 'N/A'}`);
    }
    details.push(`📦 Volume: ${volumeSpike ? 'TĂNG ĐỘT BIẾN' : 'BÌNH THƯỜNG'}`);
    details.push(`🛡️ Hỗ trợ: ${indicators.supportRes.support.toFixed(4)}, Kháng cự: ${indicators.supportRes.resistance.toFixed(4)}`);
    const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    details.push(`⏰ Thời gian: ${timestamp}`);
    if (indicators.adx < 20) details.push(`📊 Xu hướng: Đi ngang`);
    else if (longProb > shortProb) details.push(`📈 Xu hướng: Tăng (dự đoán AI)`);
    else if (shortProb > longProb) details.push(`📉 Xu hướng: Giảm (dự đoán AI)`);
    else details.push(`📊 Xu hướng: Không rõ`);
    if (signalText !== '⚪️ ĐỢI - Chưa có tín hiệu') {
        let risk, reward, rr;
        if (signalText.includes('LONG')) {
            risk = entry - sl;
            reward = tp - entry;
        } else {
            risk = sl - entry;
            reward = entry - tp;
        }
        if (risk > 0) {
            rr = (reward / risk).toFixed(2);
            details.push(`⚖️ R:R: ${rr}:1`);
        } else {
            details.push(`⚖️ R:R: N/A`);
        }
        details.push(`✅ Độ tin cậy: ${confidence}%`);
        details.push(`🎯 Điểm vào: ${entry.toFixed(4)}`);
        details.push(`🛑 SL: ${sl.toFixed(4)}`);
        details.push(`💰 TP: ${tp.toFixed(4)}`);
        const leverage = signalText === '🟢 LONG - Mua'
            ? Math.round(longProb * 125)
            : Math.round(shortProb * 125);
        const safeLeverage = Math.min(leverage, 125);
        details.push(`💡 Khuyến nghị đòn bẩy: x${safeLeverage}`);
    }

    return {
        result: `📊 *Phân tích ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframe})*\n💰 Giá: ${currentPrice.toFixed(4)}\n⚡️ *${signalText}*\n${details.join('\n')}`,
        confidence,
        signalType,
        entryPrice: entry,
        sl,
        tp
    };
}

// SELF-EVALUATE & TRAIN
let enableSimulation = true;
let trainingCounter = 0;
let shouldStopTraining = false;

async function selfEvaluateAndTrain(historicalSlice, currentIndex, fullData, symbol, pair, timeframe) {
    // Kiểm tra điều kiện đầu vào
    if (!model) {
        console.error('❌ Mô hình chưa được khởi tạo.');
        return;
    }
    if (!historicalSlice || !fullData || shouldStopTraining) {
        console.log('🚫 Dừng huấn luyện: Dữ liệu không hợp lệ hoặc đã dừng.');
        return;
    }
    if (historicalSlice.length < currentConfig.windowSize) {
        console.log(`🚫 Dữ liệu (${historicalSlice.length}) nhỏ hơn windowSize (${currentConfig.windowSize}).`);
        return;
    }
    if (currentIndex + 10 > fullData.length) {
        console.log(`🚫 Không đủ dữ liệu tương lai (${fullData.length - currentIndex} nến còn lại).`);
        return;
    }

    // Lấy giá hiện tại và tương lai
    const currentPrice = historicalSlice[historicalSlice.length - 1].close;
    const futureData = fullData.slice(currentIndex + 1, currentIndex + 11); // 10 nến tương lai
    const futurePrice = futureData[futureData.length - 1].close;
    if (typeof currentPrice !== 'number' || typeof futurePrice !== 'number') {
        console.log('🚫 Giá hiện tại hoặc tương lai không hợp lệ.');
        return;
    }

    // Tính toán tín hiệu thực tế dựa trên ATR
    const atr = computeATR(historicalSlice.slice(-14)) || 0.0001;
    const priceChange = ((futurePrice - currentPrice) / currentPrice) * 100;
    const threshold = atr * 100; // Ngưỡng thay đổi giá dựa trên ATR
    let trueSignal;
    if (priceChange > threshold) trueSignal = [1, 0, 0]; // LONG
    else if (priceChange < -threshold) trueSignal = [0, 1, 0]; // SHORT
    else trueSignal = [0, 0, 1]; // WAIT

    // Tính toán đặc trưng
    const windowFeatures = [];
    for (let i = historicalSlice.length - currentConfig.windowSize; i < historicalSlice.length; i++) {
        const features = computeFeature(historicalSlice, i, symbol, pair, timeframe);
        if (!features || features.some(f => isNaN(f))) {
            console.warn(`⚠️ Bỏ qua nến ${i} do dữ liệu không hợp lệ.`);
            return;
        }
        windowFeatures.push(features);
    }

    // Chuẩn bị dữ liệu huấn luyện
    const futureSignals = Array(5).fill(trueSignal); // Chuỗi 5 bước với tín hiệu giống nhau
    trainingCounter++;

    try {
        const usedMemoryMB = process.memoryUsage().heapUsed / 1024 / 1024;
        const batchSize = usedMemoryMB > 450 ? 8 : 16;

        // Tạo tensor với kích thước đúng
        const xs = tf.tensor3d([windowFeatures], [1, currentConfig.windowSize, 22]);
        const ys = tf.tensor3d([futureSignals], [1, 5, 3]);

        // Huấn luyện mô hình
        const history = await model.fit(xs, ys, {
            epochs: 1,
            batchSize,
            shuffle: true
        });

        // Lấy độ chính xác thực tế từ metrics nếu có
        const loss = history.history.loss[0];
        const accuracy = history.history.accuracy ? history.history.accuracy[0] : 1.0 - loss; // Fallback nếu không có accuracy
        lastAccuracy = accuracy;
        recentAccuracies.push(accuracy);
        if (recentAccuracies.length > 50) recentAccuracies.shift();

        console.log(`✅ Huấn luyện tại nến ${currentIndex} | RAM: ${usedMemoryMB.toFixed(2)} MB | Loss: ${loss.toFixed(4)} | Accuracy: ${(accuracy * 100).toFixed(2)}%`);

        // Giải phóng bộ nhớ
        xs.dispose();
        ys.dispose();
    } catch (error) {
        console.error(`❌ Lỗi huấn luyện tại nến ${currentIndex}: ${error.message}`);
    }
}

// SIMULATION
let lastIndexMap = new Map();
const SIGNAL_COOLDOWN = 10 * 60 * 1000;
const signalBuffer = new Map();
let apiErrorCounter = 0;

async function simulateTrade(symbol, pair, timeframe, signal, entryPrice, sl, tp, timestamp) {
    const cacheKey = `${symbol}_${pair}_${timeframe}`;
    let data = cacheKlines.has(cacheKey) ? cacheKlines.get(cacheKey) : [];
    const minCandlesNeeded = 50;

    if (!data || data.length < minCandlesNeeded) {
        subscribeBinance(symbol, pair, timeframe);
        const maxWaitTime = 5000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitTime) {
            data = cacheKlines.get(cacheKey) || [];
            if (data.length >= minCandlesNeeded) break;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (data.length < minCandlesNeeded) {
            data = await fetchKlines(symbol, pair, timeframe, minCandlesNeeded);
            if (!data || data.length < minCandlesNeeded) return { exitPrice: null, profit: null };
        }
    }

    let exitPrice = null, profit = null;
    for (let i = 0; i < data.length; i++) {
        if (data[i].timestamp <= timestamp) continue;
        const high = data[i].high, low = data[i].low;
        if (signal === 'LONG') {
            if (low <= sl) { exitPrice = sl; profit = ((sl - entryPrice) / entryPrice) * 100; break; }
            else if (high >= tp) { exitPrice = tp; profit = ((tp - entryPrice) / entryPrice) * 100; break; }
        } else if (signal === 'SHORT') {
            if (high >= sl) { exitPrice = sl; profit = ((entryPrice - sl) / entryPrice) * 100; break; }
            else if (low <= tp) { exitPrice = tp; profit = ((entryPrice - tp) / entryPrice) * 100; break; }
        }
    }
    if (!exitPrice) {
        exitPrice = data[data.length - 1].close;
        profit = signal === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100;
    }
    return { exitPrice, profit };
}

async function simulateConfig(config, stepInterval) {
    const { chatId, symbol, pair, timeframe } = config;
    const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;
    const cacheKey = `${symbol}_${pair}_${timeframe}`;

    let historicalData = cacheKlines.has(cacheKey) ? cacheKlines.get(cacheKey) : [];
    const minCandlesNeeded = 200;

    if (!historicalData || historicalData.length < minCandlesNeeded) {
        console.warn(`⚠️ Không đủ dữ liệu (${historicalData.length}/${minCandlesNeeded}) cho ${symbol}/${pair} (${timeframe}).`);
        subscribeBinance(symbol, pair, timeframe);
        const maxWaitTime = 10000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitTime) {
            historicalData = cacheKlines.get(cacheKey) || [];
            if (historicalData.length >= minCandlesNeeded) break;
            console.log(`⏳ Đợi dữ liệu WebSocket: ${historicalData.length}/${minCandlesNeeded}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (historicalData.length < minCandlesNeeded) {
            historicalData = await fetchKlines(symbol, pair, timeframe, minCandlesNeeded);
            if (!historicalData || historicalData.length < minCandlesNeeded) {
                console.error(`❌ Không thể lấy đủ dữ liệu cho ${symbol}/${pair}.`);
                return;
            }
        }
    }

    let currentIndex = lastIndexMap.has(configKey) ? lastIndexMap.get(configKey) : currentConfig.windowSize;

    async function simulateStep() {
        if (currentIndex >= historicalData.length || !enableSimulation) {
            console.log(`✅ Dừng giả lập ${symbol}/${pair} (${timeframes[timeframe]})`);
            lastIndexMap.delete(configKey);
            return;
        }
        try {
            const historicalSlice = historicalData.slice(0, currentIndex);
            if (historicalSlice.length < currentConfig.windowSize) {
                currentIndex++;
                setTimeout(simulateStep, stepInterval);
                return;
            }
            const { result, confidence, signalType, signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);
            const now = Date.now();
            if (!shouldStopTraining) await selfEvaluateAndTrain(historicalSlice, currentIndex, historicalData, symbol, pair, timeframe);
            lastIndexMap.set(configKey, currentIndex + 1);
            currentIndex++;
            setTimeout(simulateStep, stepInterval);
        } catch (error) {
            console.error(`Lỗi giả lập ${symbol}/${pair}: ${error.message}`);
            setTimeout(simulateStep, 30000);
        }
    }

    console.log(`🚀 Bắt đầu giả lập ${symbol}/${pair} (${timeframes[timeframe]}) từ nến ${currentIndex}...`);
    simulateStep();
}

async function simulateRealTimeForConfigs(stepInterval = 1000) {
    const configs = await loadWatchConfigs();
    if (!configs || configs.length === 0) return;
    for (const config of configs) {
        await simulateConfig(config, stepInterval);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function isValidMarket(symbol, pair) {
    try {
        const response = await axios.get(`${BINANCE_API}/ticker/price`, { params: { symbol: `${symbol.toUpperCase()}${pair.toUpperCase()}` }, timeout: 5000 });
        return !!response.data.price;
    } catch (error) {
        return false;
    }
}

// BOT COMMANDS
const autoWatchList = new Map();


bot.onText(/\?(.+)/, async (msg, match) => {
    try {
        const parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: ?ada,usdt,5m');

        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);
        if (!timeframes[timeframe]) return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ!`);

        const valid = await isValidMarket(symbol, pair);
        if (!valid) return bot.sendMessage(msg.chat.id, `⚠️ Cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} không tồn tại trên Binance!`);

        const chatId = msg.chat.id;
        const { result } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);
        bot.sendMessage(msg.chat.id, result, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi phân tích: ${error.message}`);
    }
});

bot.onText(/\/tinhieu (.+)/, async (msg, match) => {
    try {
        let parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) {
            parts = match[1].split(/\s+/).map(p => p.trim().toLowerCase());
            if (parts.length !== 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: /tinhieu ada,usdt,5m');
        }
        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);
        if (!timeframes[timeframe]) return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ!`);

        const valid = await isValidMarket(symbol, pair);
        if (!valid) return bot.sendMessage(msg.chat.id, `⚠️ Cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} không tồn tại trên Binance!`);

        const chatId = msg.chat.id;
        if (!autoWatchList.has(chatId)) autoWatchList.set(chatId, []);
        const watchList = autoWatchList.get(chatId);
        if (!watchList.some(w => w.symbol === symbol && w.pair === pair && w.timeframe === timeframe)) {
            watchList.push({ symbol, pair, timeframe });
            addWatchConfig(chatId, symbol, pair, timeframe, (err) => {
                if (err) console.error('Lỗi lưu cấu hình:', err.message);
            });
            bot.sendMessage(msg.chat.id, `✅ Đã bật theo dõi ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})`);
            subscribeBinance(symbol, pair,timeframe);
            const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;
            if (!lastIndexMap.has(configKey)) simulateConfig({ chatId, symbol, pair, timeframe }, 1000);
        } else {
            bot.sendMessage(msg.chat.id, 'ℹ️ Bạn đã theo dõi cặp này rồi!');
        }
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi /tinhieu: ${error.message}`);
    }
});

bot.onText(/\/dungtinhieu (.+)/, (msg, match) => {
    try {
        const parts = match[1].split(',').map(p => p.trim().toLowerCase());
        if (parts.length < 3) return bot.sendMessage(msg.chat.id, '⚠️ Cú pháp sai! Ví dụ: /dungtinhieu ada,usdt,5m');

        const [symbol, pair, timeframeInput] = parts;
        const timeframe = normalizeTimeframe(timeframeInput);

        if (!timeframe || !supportedTimeframes.includes(timeframe)) {
            return bot.sendMessage(msg.chat.id, `⚠️ Khung thời gian không hợp lệ! Hỗ trợ: ${supportedTimeframes.join(', ')}`);
        }

        const chatId = msg.chat.id;
        if (!autoWatchList.has(chatId)) {
            return bot.sendMessage(chatId, 'ℹ️ Bạn chưa theo dõi cặp nào.');
        }

        const watchList = autoWatchList.get(chatId);
        const idx = watchList.findIndex(w => w.symbol === symbol && w.pair === pair && w.timeframe === timeframe);

        if (idx !== -1) {
            watchList.splice(idx, 1);
            unsubscribeBinance(symbol, pair, timeframe);
            bot.sendMessage(chatId, `✅ Đã dừng theo dõi ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframe})`);
        } else {
            bot.sendMessage(chatId, `ℹ️ Bạn chưa theo dõi cặp ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframe})!`);
        }
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Lỗi /dungtinhieu: ${error.message}`);
    }
});

bot.onText(/\/lichsu/, (msg) => {
    const chatId = msg.chat.id;
    db.all(
        `SELECT symbol, pair, timeframe, signal, confidence, timestamp FROM signal_history WHERE chatId = ? ORDER BY timestamp DESC LIMIT 10`,
        [chatId],
        (err, rows) => {
            if (err) {
                console.error('Lỗi truy vấn lịch sử:', err.message);
                return bot.sendMessage(chatId, '❌ Lỗi khi lấy lịch sử tín hiệu.');
            }
            if (!rows || rows.length === 0) return bot.sendMessage(chatId, 'ℹ️ Chưa có lịch sử tín hiệu nào.');
            const historyText = rows.map(row => {
                const date = new Date(row.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                return `${row.symbol.toUpperCase()}/${row.pair.toUpperCase()} (${timeframes[row.timeframe]}): ${row.signal} (${row.confidence}%) - ${date}`;
            }).join('\n');
            bot.sendMessage(chatId, `📜 *LỊCH SỬ TÍN HIỆU (10 gần nhất)*\n${historyText}`, { parse_mode: 'Markdown' });
        }
    );
});

bot.onText(/\/tradehistory/, (msg) => {
    const chatId = msg.chat.id;
    db.all(
        `SELECT symbol, pair, timeframe, signal, entry_price, exit_price, profit, timestamp 
         FROM signal_history 
         WHERE chatId = ? AND entry_price IS NOT NULL 
         ORDER BY timestamp DESC LIMIT 10`,
        [chatId],
        (err, rows) => {
            if (err) {
                console.error('Lỗi truy vấn lịch sử giao dịch:', err.message);
                return bot.sendMessage(chatId, '❌ Lỗi khi lấy lịch sử giao dịch.');
            }
            if (!rows || rows.length === 0) return bot.sendMessage(chatId, 'ℹ️ Chưa có lịch sử giao dịch nào.');

            const historyText = rows.map(row => {
                const date = new Date(row.timestamp).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
                const profitText = row.profit !== null ? `${row.profit.toFixed(2)}%` : 'Đang chờ';
                return `${row.symbol.toUpperCase()}/${row.pair.toUpperCase()} (${timeframes[row.timeframe]}): ${row.signal}\n- Entry: ${row.entry_price.toFixed(4)}, Exit: ${row.exit_price ? row.exit_price.toFixed(4) : 'N/A'}, Profit: ${profitText}\n- ${date}`;
            }).join('\n\n');
            bot.sendMessage(chatId, `📜 *LỊCH SỬ GIAO DỊCH GIẢ LẬP (10 gần nhất)*\n\n${historyText}`, { parse_mode: 'Markdown' });
        }
    );
});
bot.onText(/\/status/, (msg) => {
    try {
        const chatId = msg.chat.id;
        const memoryUsage = process.memoryUsage();
        const usedMemoryMB = memoryUsage.heapUsed / 1024 / 1024;

        if (!recentAccuracies || !trainingCounter || typeof enableSimulation === 'undefined' || !currentConfig) {
            throw new Error('Biến cần thiết chưa được định nghĩa.');
        }

        if (!Array.isArray(recentAccuracies)) recentAccuracies = [];
        if (!currentConfig || typeof currentConfig.windowSize === 'undefined' || typeof currentConfig.units === 'undefined' || typeof currentConfig.epochs === 'undefined') {
            throw new Error('Cấu hình mô hình chưa hợp lệ.');
        }

        const avgAcc = recentAccuracies.length > 0 ? recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length : 0;
        const maxAcc = recentAccuracies.length > 0 ? Math.max(...recentAccuracies) : 0;
        const minAcc = recentAccuracies.length > 0 ? Math.min(...recentAccuracies) : 0;

        const statusMessage = `
📊 *Trạng thái Bot*
- Số lần huấn luyện: ${trainingCounter}
- Độ chính xác trung bình: ${(avgAcc * 100).toFixed(2)}\%
- Độ chính xác cao nhất: ${(maxAcc * 100).toFixed(2)}\%
- Độ chính xác thấp nhất: ${(minAcc * 100).toFixed(2)}\%
- RAM: ${usedMemoryMB.toFixed(2)} MB
- Giả lập: ${enableSimulation ? 'Đang chạy' : 'Đã dừng'}
- Cấu hình mô hình: WINDOW_SIZE=${currentConfig.windowSize}, Units=${currentConfig.units}, Epochs=${currentConfig.epochs}
        `.trim();

        console.log(`Gửi statusMessage: ${statusMessage}`);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Gửi statusMessage: ${statusMessage}\n`);
        bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML' });
    } catch (error) {
        console.error('Chi tiết lỗi:', error);
        fs.appendFileSync(BOT_LOG_PATH, `${new Date().toISOString()} - Lỗi: ${error.stack}\n`);
        bot.sendMessage(msg.chat.id, `❌ Lỗi trạng thái: ${error.message}`);
    }
});

bot.onText(/\/trogiup/, (msg) => {
    const helpMessage = `
📚 *HƯỚNG DẪN SỬ DỤNG BOT GIAO DỊCH*
1. **?symbol,pair,timeframe** - Phân tích thủ công. Ví dụ: ?ada,usdt,5m
2. **/tinhieu symbol,pair,timeframe** - Bật theo dõi tự động. Ví dụ: /tinhieu ada,usdt,5m
3. **/dungtinhieu symbol,pair,timeframe** - Dừng theo dõi tự động. Ví dụ: /dungtinhieu ada,usdt,5m
4. **/lichsu** - Xem 10 tín hiệu gần nhất.
5. **/tradehistory** - Xem 10 giao dịch giả lập gần nhất.
6. **/status** - Xem trạng thái bot.
7. **/showindicators** và **/hideindicators** - Bật/tắt chỉ số kỹ thuật.
8. **/resettraining** - Đặt lại bộ đếm huấn luyện.
9. **/trogiup** - Hiển thị hướng dẫn này.
`;
    bot.sendMessage(msg.chat.id, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/showindicators/, async (msg) => {
    const chatId = msg.chat.id;
    setUserSettings(chatId, 1);
    bot.sendMessage(chatId, '✅ Đã bật hiển thị chỉ số kỹ thuật.');
});

bot.onText(/\/hideindicators/, async (msg) => {
    const chatId = msg.chat.id;
    setUserSettings(chatId, 0);
    bot.sendMessage(chatId, '✅ Đã tắt hiển thị chỉ số kỹ thuật.');
});

bot.onText(/\/resettraining/, (msg) => {
    const chatId = msg.chat.id;
    trainingCounter = 0;
    shouldStopTraining = false;
    bot.sendMessage(chatId, '✅ Đã đặt lại bộ đếm huấn luyện và trạng thái dừng.');
    console.log(`✅ Đã đặt lại trainingCounter về 0 bởi chat ${chatId}`);
});


// Kiểm tra tín hiệu tự động
async function checkAutoSignal(chatId, { symbol, pair, timeframe }, confidenceThreshold = 70) {
    const configKey = `${chatId}_${symbol}_${pair}_${timeframe}`;
    const now = Date.now();

    const lastSignal = signalBuffer.get(configKey);
    const { result, confidence, signalType, signalText, entryPrice, sl, tp } = await getCryptoAnalysis(symbol, pair, timeframe, chatId);

    if (confidence < confidenceThreshold || signalType === 'WAIT') return;

    const df = await fetchKlines(symbol, pair, timeframe, 50);
    const atr = df ? computeATR(df) : 0.0001;
    const priceChangeThreshold = atr * 0.5;

    if (lastSignal && Math.abs((entryPrice - lastSignal.entryPrice) / lastSignal.entryPrice) < priceChangeThreshold) {
        console.log(`⚠️ Giá thay đổi không đáng kể (${(priceChangeThreshold * 100).toFixed(2)}%), bỏ qua tín hiệu ${symbol}/${pair}.`);
        return;
    }

    if (lastSignal && now - lastSignal.timestamp < SIGNAL_COOLDOWN) {
        console.log(`⚠️ Tín hiệu ${symbol}/${pair} bị chặn do cooldown.`);
        return;
    }

    bot.sendMessage(chatId, `🚨 *TÍN HIỆU ${symbol.toUpperCase()}/${pair.toUpperCase()} (${timeframes[timeframe]})* 🚨\n${result}`, { parse_mode: 'Markdown' });
    signalBuffer.set(configKey, { result, signalText, timestamp: now, entryPrice });

    const { exitPrice: rawExitPrice, profit: rawProfit } = await simulateTrade(symbol, pair, timeframe, signalType, entryPrice, sl, tp, now);

    if (lastSignal && lastSignal.signalText === signalText) {
        console.log(`⚠️ Tín hiệu ${symbol}/${pair} không thay đổi, không lưu vào database.`);
        return;
    }

    db.run(
        `INSERT INTO signal_history (chatId, symbol, pair, timeframe, signal, confidence, timestamp, entry_price, exit_price, profit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [chatId, symbol, pair, timeframe, signalType, confidence, now, entryPrice, rawExitPrice, rawProfit],
        (err) => {
            if (err) {
                console.error(`❌ Lỗi lưu tín hiệu ${symbol}/${pair} vào database: ${err.message}`);
                fs.appendFileSync('bot_error.log', `${new Date().toISOString()} - Lỗi SQLite: ${err.message}\n`);
            } else {
                console.log(`✅ Lưu tín hiệu ${symbol}/${pair} thành công.`);
            }
        }
    );
}
function startAutoChecking() {
    const CHECK_INTERVAL = 1 * 60 * 1000;
    setInterval(() => {
        for (const [chatId, watchList] of autoWatchList) {
            watchList.forEach(async (config) => {
                try {
                    await checkAutoSignal(chatId, config);
                } catch (err) {
                    console.error(`❌ Lỗi checkAutoSignal: ${err.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            });
        }
    }, CHECK_INTERVAL);
}
function dynamicTrainingControl() {
    if (recentAccuracies.length < 50) return;
    const avgAcc = recentAccuracies.reduce((sum, val) => sum + val, 0) / recentAccuracies.length;
    const maxAcc = Math.max(...recentAccuracies);
    const minAcc = Math.min(...recentAccuracies);

    if (avgAcc > 0.85 && (maxAcc - minAcc) < 0.05) {
        if (enableSimulation) {
            enableSimulation = false;
            shouldStopTraining = false; // Thêm dòng này nếu bạn muốn đặt lại trạng thái dừng
            trainingCounter = 0; // Đặt lại bộ đếm khi mô hình ổn định
            console.log("✅ Dynamic Training Control: Mô hình ổn định, dừng giả lập và đặt lại trainingCounter.");
            if (adminChatId) {
                bot.sendMessage(adminChatId, `✅ *Mô hình đã ổn định* | Accuracy: ${(avgAcc * 100).toFixed(2)}% | Đã dừng giả lập và đặt lại bộ đếm huấn luyện.`, { parse_mode: 'Markdown' });
            }
        }
    } else {
        if (!enableSimulation) {
            enableSimulation = true;
            console.log("⚡ Dynamic Training Control: Hiệu suất chưa ổn định, kích hoạt lại giả lập.");
            simulateRealTimeForConfigs(1000);
        } else {
            console.log("⚡ Dynamic Training Control: Hiệu suất chưa ổn định, tiếp tục giả lập.");
            simulateRealTimeForConfigs(1000);
        }
    }
}

// KHỞI ĐỘNG BOT
(async () => {
    await initializeModel();
    await trainModelWithMultiplePairs();
    startAutoChecking();
    await simulateRealTimeForConfigs(1000);
    setInterval(dynamicTrainingControl, 10 * 60 * 1000);
    // setInterval(() => {
    //     console.log("⏳ Đang kiểm tra và tối ưu mô hình...");
    //     optimizeModel();
    // }, 3 * 60 * 60 * 1000); //  giờ
})();
