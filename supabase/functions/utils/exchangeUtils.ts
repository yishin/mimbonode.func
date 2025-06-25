/**
 * getBnbPriceFromBinance
 *
 * @returns {Number} BNB 가격
 */
export async function getBnbPriceFromBinance() {
    try {
        const res = await fetch(
            "https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT",
        );
        const data = await res.json();
        return parseFloat(data.price);
    } catch (err) {
        console.error("Fetching BNB price failed:", err);
        return 0;
    }
}

/**
 * getXrpPriceFromBinance
 *
 * @returns {Number} XRP 가격
 */
export async function getXrpPriceFromBinance() {
    try {
        const res = await fetch(
            "https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT",
        );
        const data = await res.json();
        return parseFloat(data.price);
    } catch (err) {
        console.error("Fetching XRP price failed:", err);
        return 0;
    }
}

/**
 * getSolPriceFromBinance
 *
 * @returns {Number} SOL 가격
 */
export async function getSolPriceFromBinance() {
    try {
        const res = await fetch(
            "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
        );
        const data = await res.json();
        return parseFloat(data.price);
    } catch (err) {
        console.error("Fetching SOL price failed:", err);
        return 0;
    }
}
