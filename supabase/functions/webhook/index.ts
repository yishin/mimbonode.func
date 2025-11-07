// supabase/functions/webhook/index.ts
import { supabase } from "../utils/supabaseClient.ts";

// 텔레그램 메시지 전송 함수
async function sendTelegramMessage(message: string) {
  try {
    const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const TELEGRAM_CHAT_ID = "-5098079433"; // 고정된 채팅방 ID

    if (!TELEGRAM_BOT_TOKEN) {
      console.warn("Telegram bot token not configured");
      return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Telegram API error:", error);
    } else {
      console.log("Telegram message sent successfully");
    }
  } catch (error) {
    console.error("Error sending Telegram message:", error);
  }
}

async function blockUser(userId: string, reason: string) {
  const { data: userData, error: userError } = await supabase
    .from("profiles")
    .update({ is_block: true, block_reason: reason })
    .eq("user_id", userId)
    .select("username")
    .single();

  if (userError) {
    console.error("Error blocking user:", userError);
    return;
  }

  return userData;
}
// Wei to Ether 변환 함수 (18 decimals)
function fromWei(value: string | bigint, decimals: number = 18): string {
  try {
    const wei = BigInt(value);
    const divisor = BigInt(10 ** decimals);
    const ether = wei / divisor;
    const remainder = wei % divisor;

    // 소수점 이하 처리
    if (remainder === 0n) {
      return ether.toString();
    }

    // 소수점 이하 6자리까지만 표시
    const decimalStr = remainder.toString().padStart(decimals, "0");
    const significantDecimals = decimalStr.slice(0, 6).replace(/0+$/, "");

    if (significantDecimals === "") {
      return ether.toString();
    }

    return `${ether}.${significantDecimals}`;
  } catch (error) {
    console.error("Error converting from Wei:", error);
    return "0";
  }
}

// MGG Token Transfer 이벤트 파싱 함수
function parseQuickNodeWebhook(data: any) {
  try {
    const transfers = [];

    // matchingReceipts 배열 처리
    const receipts = data.matchingReceipts || data.logs || [];

    for (const receipt of receipts) {
      // 각 receipt의 logs 처리
      const logs = receipt.logs || [];

      // Transfer 이벤트 시그니처: Transfer(address,address,uint256)
      const transferEventSignature =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      const transferLogs = logs.filter((log: any) =>
        log.topics && log.topics[0] === transferEventSignature
      );

      for (const log of transferLogs) {
        // topics[1] = from address (32 bytes, 뒤 20 bytes가 실제 주소)
        // topics[2] = to address (32 bytes, 뒤 20 bytes가 실제 주소)
        const from = log.topics[1]
          ? `0x${log.topics[1].slice(26).toLowerCase()}`
          : null;
        const to = log.topics[2]
          ? `0x${log.topics[2].slice(26).toLowerCase()}`
          : null;

        // data = amount (uint256) - Wei 단위
        const amountWei = log.data ? BigInt(log.data).toString() : "0";
        const amountFormatted = fromWei(amountWei, 18); // MGG는 18 decimals

        transfers.push({
          from,
          to,
          amount: amountFormatted,
          amountWei, // 원본 Wei 값도 저장
          contractAddress: log.address?.toLowerCase(),
          transactionHash: receipt.transactionHash || log.transactionHash,
          blockNumber: parseInt(receipt.blockNumber || log.blockNumber, 16),
          blockTimestamp: log.blockTimestamp
            ? new Date(parseInt(log.blockTimestamp, 16) * 1000).toISOString()
            : new Date().toISOString(),
          logIndex: log.logIndex,
          receiptStatus: receipt.status,
          gasUsed: receipt.gasUsed,
        });
      }
    }

    return transfers;
  } catch (error) {
    console.error("Error parsing QuickNode webhook:", error);
    return [];
  }
}

// Edge Function 시작
Deno.serve(async (req) => {
  try {
    // CORS 및 OPTIONS 요청 처리
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    console.log(
      "> Webhook request received - Method:",
      req.method,
      "URL:",
      req.url,
    );
    // console.log("Headers:", Object.fromEntries(req.headers.entries()));

    // 헤더를 하나씩 출력
    // console.log("=== Headers Detail ===");
    // req.headers.forEach((value, key) => {
    //   console.log(`Header [${key}]: ${value}`);
    // });
    // console.log("=== End Headers ===");

    // const token = url.searchParams.get("token");
    // console.log("token:", token);

    const QUICKNODE_TOKEN = Deno.env.get("QUICKNODE_WEBHOOK_TOKEN");

    // QuickNode webhook은 두 가지 방식으로 인증 가능:
    // 1. URL token 파라미터 (권장)
    // 2. Authorization 헤더 (선택사항)

    // const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    // const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // QuickNode 토큰이 설정되어 있고 URL에 토큰이 있는 경우
    // if (QUICKNODE_TOKEN && QUICKNODE_TOKEN !== "") {
    //   // URL 토큰으로 인증
    //   if (token === QUICKNODE_TOKEN) {
    //     console.log("Authenticated via QuickNode token");
    //   } else {
    //     console.error("Invalid QuickNode token");
    //     return new Response(
    //       JSON.stringify({
    //         error: "Unauthorized",
    //         message: "Invalid webhook token",
    //       }),
    //       {
    //         status: 401,
    //         headers: { "Content-Type": "application/json" },
    //       },
    //     );
    //   }
    // } // Authorization 헤더로 인증 (선택사항)
    // else if (authHeader && authHeader.startsWith("Bearer ")) {
    //   const providedKey = authHeader.replace("Bearer ", "");
    //   const isValidKey = providedKey === SUPABASE_ANON_KEY ||
    //     providedKey === SUPABASE_SERVICE_ROLE_KEY;

    //   if (!isValidKey) {
    //     console.error("Invalid API key provided");
    //     return new Response(
    //       JSON.stringify({
    //         code: 401,
    //         message: "Invalid API key",
    //       }),
    //       {
    //         status: 401,
    //         headers: { "Content-Type": "application/json" },
    //       },
    //     );
    //   }
    //   console.log("Authenticated via Bearer token");
    // } // 개발/테스트 환경: 토큰이 설정되지 않은 경우 경고만 표시
    // else if (!QUICKNODE_TOKEN || QUICKNODE_TOKEN === "") {
    //   console.warn(
    //     "WARNING: No authentication configured. This is insecure for production.",
    //   );
    // }

    const webhookData = await req.json();
    console.log("Webhook data received:", JSON.stringify(webhookData));

    // QuickNode webhook 데이터 파싱
    const transfers = parseQuickNodeWebhook(webhookData);
    console.log(`Found ${transfers.length} transfer events`);

    // 각 transfer 이벤트에 대해 처리
    for (const transfer of transfers) {
      if (transfer.amountWei === "0") {
        console.log("Skipping transfer with amount 0");
        continue;
      }

      console.log("Processing transfer:", {
        from: transfer.from,
        to: transfer.to,
        amount: `${transfer.amount} MGG`,
        txHash: transfer.transactionHash,
      });

      // transfer.from 과 transfer.to 값이 없으면...
      if (!transfer.from || !transfer.to) {
        console.error("Transfer from or to address is missing");
        continue;
      }

      // wallets 테이블에서 from 주소 확인 (대소문자 무시)
      const { data: fromWallet } = await supabase
        .from("wallets")
        .select("address, user_id, username, memo")
        .ilike("address", transfer.from) // ilike로 대소문자 무시 비교
        .single();

      // wallets 테이블에서 to 주소 확인 (대소문자 무시)
      const { data: toWallet } = await supabase
        .from("wallets")
        .select("address, user_id, username, memo, sid")
        .ilike("address", transfer.to) // ilike로 대소문자 무시 비교
        .single();
      console.log("toWallet:", JSON.stringify(toWallet));

      // from 주소가 wallets에 없고, to 주소가 wallets에 있는 경우 (외부에서 내부로 전송)
      if (!fromWallet && toWallet && toWallet.sid > 1000) {
        console.log(
          `>>> External transfer detected from ${transfer.from} to ${toWallet.username} (${transfer.to})`,
        );

        // 외부에서 내부로의 전송만 DB에 저장
        const { error: logError } = await supabase
          .from("webhook_log")
          .insert({
            webhook_type: "quicknode",
            event_type: "external_token_transfer",
            contract_address: transfer.contractAddress,
            from_address: transfer.from,
            to_address: transfer.to,
            token_symbol: "MGG",
            token_amount: transfer.amount, // 변환된 값 (예: 203.4766)
            transaction_hash: transfer.transactionHash,
            block_number: transfer.blockNumber,
            block_timestamp: transfer.blockTimestamp,
            raw_data: webhookData,
            processed: true,
            processed_at: new Date().toISOString(),
            metadata: {
              amountWei: transfer.amountWei, // 원본 Wei 값 보관
              logIndex: transfer.logIndex,
              gasUsed: transfer.gasUsed,
              receiptStatus: transfer.receiptStatus,
              is_external_transfer: true,
              to_username: toWallet.username,
              to_user_id: toWallet.user_id,
            },
          });

        if (logError) {
          console.error("Error logging external transfer:", logError);
        }

        // 사용자 차단
        const blockedUser = await blockUser(
          toWallet.user_id,
          "Unauthorized transfer to internal wallet",
        );

        if (blockedUser) {
          console.log("User blocked:", blockedUser.username);
        }

        // 텔레그램 알림 전송
        const telegramMessage = `
🚨 <b>외부 MGG 전송 감지</b>

<b>From:</b> <code>${transfer.from}</code>
<b>To:</b> ${toWallet.username || toWallet.memo} (<code>${transfer.to}</code>)
${blockedUser ? `<b>Blocked:</b> ${blockedUser.username}` : ""}
<b>Amount:</b> ${transfer.amount} MGG
<b>TxBlock:</b> ${transfer.blockNumber}
<b>TxHash:</b> <code>${transfer.transactionHash}</code>

<a href="https://bscscan.com/tx/${transfer.transactionHash}">View on BSCScan</a>
        `.trim();

        await sendTelegramMessage(telegramMessage);

        // TODO: 차단 로직 추가
        // if (shouldBlock) {
        //   await supabase.from("blocked_addresses").insert({
        //     address: transfer.from,
        //     blocked_at: new Date().toISOString(),
        //     blocked_reason: "Unauthorized transfer to internal wallet",
        //     transaction_hash: transfer.transactionHash,
        //     from_address: transfer.from,
        //     to_address: transfer.to,
        //     token_symbol: "MGG",
        //     amount: transfer.amount
        //   });
        // }
      } else if (fromWallet && toWallet) {
        console.log(
          `>>> Internal transfer from ${
            fromWallet.username || fromWallet.memo
          } to ${toWallet.username || toWallet.memo} - skipping DB save`,
        );

        // 텔레그램 알림 전송
        // const telegramMessage = `
        //         🚨 <b>내부 MGG 전송 감지</b>

        //         <b>From:</b> <code>${
        //   fromWallet.username || fromWallet.memo
        // }</code>
        //         <b>To:</b> ${
        //   toWallet.username || toWallet.memo
        // } (<code>${transfer.to}</code>)
        //         <b>Amount:</b> ${transfer.amount} MGG
        //         <b>Block:</b> ${transfer.blockNumber}
        //         <b>TxHash:</b> <code>${transfer.transactionHash}</code>

        //         <a href="https://bscscan.com/tx/${transfer.transactionHash}">View on BSCScan</a>
        //                 `.trim();

        // await sendTelegramMessage(telegramMessage);
      } else if (fromWallet && !toWallet) {
        console.log(
          `>>> Internal to external transfer from ${
            fromWallet.username || fromWallet.memo
          } - skipping DB save`,
        );
      } else {
        console.log(
          `>>> External to external transfer - skipping DB save ${
            JSON.stringify(transfer)
          }`,
        );
      }
    }

    // 기존 트랜잭션 상태 업데이트 로직 (호환성 유지)
    // if (webhookData.txHash && webhookData.status) {
    //   const { txHash, status } = webhookData;

    //   const validStatuses = ["pending", "completed", "failed"];
    //   if (validStatuses.includes(status)) {
    //     await supabase
    //       .from("transactions")
    //       .update({ status })
    //       .eq("tx_hash", txHash);
    //   }
    // }

    // 성공 응답 - QuickNode가 기대하는 형식
    return new Response(
      JSON.stringify({
        success: true,
        message: "Webhook processed successfully",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    console.error("Webhook processing error:", error);

    // 에러 응답도 JSON 형식으로
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Internal server error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
