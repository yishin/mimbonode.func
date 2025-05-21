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
