// 텔레그램 관련 설정
const ENV = Deno.env.get("ENV");
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const TELEGRAM_NOTIFY_ID = Deno.env.get("TELEGRAM_NOTIFY_ID");
const TELEGRAM_BLOCK_ID = Deno.env.get("TELEGRAM_BLOCK_ID");
const TELEGRAM_DW_TX_ID = Deno.env.get("TELEGRAM_DW_TX_ID");
const TELEGRAM_OP_WALLET_ID = Deno.env.get("TELEGRAM_OP_WALLET_ID");

export async function sendTelegramMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: ENV === "production" ? TELEGRAM_NOTIFY_ID : TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("💬 Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("❌ Error sending Telegram message:", error);
    return null;
  }
}

export async function sendBlockMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: ENV === "production" ? TELEGRAM_BLOCK_ID : TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("💬 Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("❌ Error sending Telegram message:", error);
    return null;
  }
}

export async function sendDwTxMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: ENV === "production" ? TELEGRAM_DW_TX_ID : TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("💬 Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("❌ Error sending Telegram DW TX message:", error);
    return null;
  }
}

export async function sendOpWalletMessage(message: string) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing Telegram configuration");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: ENV === "production"
            ? TELEGRAM_OP_WALLET_ID
            : TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      },
    );

    const result = await response.json();
    console.log("💬 Telegram message sent:", result);
    return result;
  } catch (error) {
    console.error("❌ Error sending Telegram OP Wallet message:", error);
    return null;
  }
}

export async function sendTransactionMessage(params) {
  const {
    type,
    from,
    fromAddress,
    fromToken,
    fromAmount,
    to,
    toAddress,
    toToken,
    toAmount,
    settings,
    getMggBalance,
    getXrpBalance,
    getSolBalance,
    getBnbBalance,
    getUsdtBalance,
  } = params;

  const typeText = type === "TRANSFER"
    ? "🔀 내부 이체"
    : type === "SWAP"
    ? "🔄 스왑 "
    : type === "WITHDRAW"
    ? "✈️ 외부 출금"
    : type === "DEPOSIT"
    ? "💰 외부 입금"
    : "ℹ️ 기타";

  let message = `━━━━━━━━━━━━━━━\n${typeText}${
    from === to ? from : ""
  }\nFrom: ${
    (to !== from) ? (from ? from : fromAddress) : ""
  }\n${fromToken} ${fromAmount}\nTo: ${
    (to !== from) ? (to ? to : toAddress) : ""
  }\n${toToken || ""} ${toAmount || ""}`;

  if (
    type === "WITHDRAW" && fromToken !== "MGG" && settings && getXrpBalance &&
    getSolBalance && getBnbBalance && getUsdtBalance
  ) {
    const tokenBalance = fromToken === "XRP"
      ? await getXrpBalance("")
      : fromToken === "SOL"
      ? await getSolBalance("")
      : fromToken === "BNB"
      ? await getBnbBalance(settings.wallet_withdraw)
      : await getUsdtBalance(settings.wallet_withdraw);

    // 잔액 조회 실패 시 메시지에 표시하지 않음
    if (tokenBalance !== null && tokenBalance !== undefined) {
      const tokenBalanceText = fromToken === "XRP"
        ? parseFloat(tokenBalance).toLocaleString("en-US", {
          minimumFractionDigits: 6,
          maximumFractionDigits: 6,
        })
        : fromToken === "SOL"
        ? parseFloat(tokenBalance).toLocaleString("en-US", {
          minimumFractionDigits: 9,
          maximumFractionDigits: 9,
        })
        : fromToken === "BNB"
        ? parseFloat(tokenBalance).toLocaleString("en-US", {
          minimumFractionDigits: 8,
          maximumFractionDigits: 8,
        })
        : parseFloat(tokenBalance).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

      message += `\n\n> 운영 잔액: ${tokenBalanceText} ${fromToken}`;
    }
  }

  // DEPOSIT일 때 총 입금액 추가
  if (type === "DEPOSIT" && settings && getUsdtBalance) {
    const totalBalance = await getUsdtBalance(settings.wallet_deposit);
    const totalBalanceText = parseFloat(totalBalance).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    message += `\n\n> 총 입금액: ${totalBalanceText} USDT`;
  }

  // 입금/출금은 sendDwTxMessage로, 나머지는 sendTelegramMessage로 전송
  if (type === "DEPOSIT" || type === "WITHDRAW") {
    await sendDwTxMessage(message);
  } else {
    await sendTelegramMessage(message);
  }

  // 지갑 잔액 확인 및 알림
  if (
    settings && getBnbBalance && getUsdtBalance && getXrpBalance &&
    getSolBalance
  ) {
    const alertMessages = [];

    // 운영지갑 BNB 확인
    const bnbBalance = await getBnbBalance(settings.wallet_operation);
    if (parseFloat(bnbBalance) < 0.1) {
      alertMessages.push(`⚠️ 운영지갑 BNB 부족: ${bnbBalance}/0.1 BNB`);
    }

    // 보상용 MGG 확인 - getMggBalance가 params에 전달된 경우에만 확인
    if (getMggBalance) {
      const mggBalance = await getMggBalance(settings.wallet_reward);
      if (parseFloat(mggBalance) < 30_000_000) {
        alertMessages.push(
          `⚠️ 보상용 MGG 부족: ${
            parseFloat(mggBalance).toLocaleString()
          }/30,000,000 MGG`,
        );
      }
    }
    // 보상용 BNB 확인
    if (getBnbBalance) {
      const bnbBalance = await getBnbBalance(settings.wallet_reward);
      if (parseFloat(bnbBalance) < 0.001) {
        alertMessages.push(`⚠️ 보상용 BNB 부족: ${bnbBalance}/0.001 BNB`);
      }
    }

    // 출금용 USDT 확인
    const usdtBalance = await getUsdtBalance(settings.wallet_withdraw);
    if (parseFloat(usdtBalance) < 10_000) {
      alertMessages.push(
        `⚠️ 출금용 USDT 부족: ${
          parseFloat(usdtBalance).toLocaleString()
        }/10,000 USDT`,
      );
    }

    // 리플 확인
    try {
      const xrpBalance = await getXrpBalance(settings.wallet_xrp_operation);
      if (parseInt(xrpBalance) !== -1 && parseFloat(xrpBalance) < 1_000) {
        alertMessages.push(
          `⚠️ XRP 부족: ${parseFloat(xrpBalance).toLocaleString()}/1,000 XRP`,
        );
      }
    } catch (error) {
      console.error("❌ Error sending Telegram XRP message:", error);
    }

    try {
      // 솔라나 확인
      const solBalance = await getSolBalance(settings.wallet_sol_operation);
      // 잔액 조회 실패(null)인 경우는 알림을 보내지 않음
      if (solBalance !== null && parseFloat(solBalance) < 30) {
        alertMessages.push(
          `⚠️ SOL 부족: ${parseFloat(solBalance).toLocaleString()}/30 SOL`,
        );
      }
    } catch (error) {
      console.error("❌ Error sending Telegram SOL message:", error);
    }

    // 알림 메시지가 있으면 전송
    if (alertMessages.length > 0) {
      const alertMessage = `🚨 지갑 잔액 경고\n━━━━━━━━━━━━━━━\n${
        alertMessages.join("\n")
      }`;
      await sendOpWalletMessage(alertMessage);
    }
  }
}
